"""Payroll runs, salary slips, advances, settings, increments/bonuses, overtime and compensation."""

from datetime import time
from decimal import Decimal
from django.db import models

from .core import Department, Designation, Employee


# ──────────────────────────────────────────────
#  Payroll (Enterprise)
# ──────────────────────────────────────────────

class PayrollRun(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_PROCESSING = "processing"
    STATUS_APPROVED = "approved"
    STATUS_LOCKED = "locked"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_LOCKED, "Locked"),
    ]
    RUN_TYPE_MONTHLY = "monthly"
    RUN_TYPE_BIWEEKLY = "biweekly"
    RUN_TYPES = [(RUN_TYPE_MONTHLY, "Monthly"), (RUN_TYPE_BIWEEKLY, "Bi-Weekly")]

    run_code = models.TextField(unique=True, db_column="run_code")
    month = models.IntegerField()
    year = models.IntegerField()
    run_type = models.TextField(choices=RUN_TYPES, default=RUN_TYPE_MONTHLY, db_column="run_type")
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_DRAFT)
    total_employees = models.IntegerField(default=0, db_column="total_employees")
    total_gross = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_gross")
    total_deductions = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_deductions")
    total_net = models.DecimalField(max_digits=12, decimal_places=2, default=0, db_column="total_net")
    processed_by = models.TextField(null=True, blank=True, db_column="processed_by")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    locked_at = models.DateTimeField(null=True, blank=True, db_column="locked_at")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payroll_runs"


class EarningItem(models.Model):
    ITEM_TYPES = [
        ("basic", "Basic Salary"),
        ("hra", "HRA"),
        ("allowance", "Allowance"),
        ("incentive", "Incentive"),
        ("bonus", "Bonus"),
        ("ot", "Overtime"),
        ("session", "Session Pay"),
    ]

    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.CASCADE, db_column="payroll_run_id", related_name="earnings"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="earnings"
    )
    item_type = models.TextField(choices=ITEM_TYPES, db_column="item_type")
    label = models.TextField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "earning_items"


class DeductionItem(models.Model):
    ITEM_TYPES = [
        ("pf", "Provident Fund"),
        ("esi", "ESI"),
        ("advance", "Advance Recovery"),
        ("loan", "Loan Recovery"),
        ("penalty", "Penalty"),
        ("other", "Other Deduction"),
    ]

    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.CASCADE, db_column="payroll_run_id", related_name="deductions"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="deductions"
    )
    item_type = models.TextField(choices=ITEM_TYPES, db_column="item_type")
    label = models.TextField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "deduction_items"


# ──────────────────────────────────────────────
#  Settlement (Advances & Loans)
# ──────────────────────────────────────────────

class Advance(models.Model):
    ADVANCE_TYPE_GENERAL = "general"
    ADVANCE_TYPE_TERM = "term"
    ADVANCE_TYPES = [
        (ADVANCE_TYPE_GENERAL, "General Advance"),
        (ADVANCE_TYPE_TERM, "Term Advance (Loan)"),
    ]
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CLOSED = "closed"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_CLOSED, "Closed"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="advances"
    )
    advance_type = models.TextField(choices=ADVANCE_TYPES, db_column="advance_type")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    purpose = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    disbursed_at = models.DateTimeField(null=True, blank=True, db_column="disbursed_at")
    repayment_start_month = models.IntegerField(null=True, blank=True, db_column="repayment_start_month")
    repayment_start_year = models.IntegerField(null=True, blank=True, db_column="repayment_start_year")
    repayment_months = models.IntegerField(null=True, blank=True, db_column="repayment_months")
    emi_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="emi_amount")
    total_repaid = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="total_repaid")
    outstanding = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "advances"


class AdvanceRepayment(models.Model):
    PAYMENT_CASH = "cash"
    PAYMENT_GPAY = "gpay"
    PAYMENT_PAYROLL = "payroll"
    PAYMENT_METHODS = [
        (PAYMENT_CASH, "Hand Cash"),
        (PAYMENT_GPAY, "GPay"),
        (PAYMENT_PAYROLL, "Payroll Deduction"),
    ]

    advance = models.ForeignKey(
        Advance, on_delete=models.CASCADE, db_column="advance_id", related_name="repayments"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    payment_method = models.TextField(
        choices=PAYMENT_METHODS, default=PAYMENT_PAYROLL, db_column="payment_method"
    )
    is_processed = models.BooleanField(default=False, db_column="is_processed")
    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="payroll_run_id", related_name="advance_repayments"
    )
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "advance_repayments"


# ──────────────────────────────────────────────
#  Salary Slips
# ──────────────────────────────────────────────

class SalarySlip(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="salary_slips"
    )
    payroll_run = models.ForeignKey(
        PayrollRun, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="payroll_run_id", related_name="salary_slips"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    slip_number = models.TextField(unique=True, db_column="slip_number")
    basic = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    hra = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    allowances = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    incentives = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    bonuses = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    ot_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="ot_amount")
    gross_salary = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="gross_salary")
    pf_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="pf_deduction")
    esi_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="esi_deduction")
    advance_deduction = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="advance_deduction")
    other_deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="other_deductions")
    total_deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="total_deductions")
    net_salary = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="net_salary")
    working_days = models.IntegerField(default=0, db_column="working_days")
    present_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="present_days")
    absent_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="absent_days")
    paid_leave_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="paid_leave_days")
    unpaid_leave_days = models.DecimalField(max_digits=4, decimal_places=1, default=0, db_column="unpaid_leave_days")
    late_days = models.IntegerField(default=0, db_column="late_days")
    completed_sessions = models.IntegerField(default=0, db_column="completed_sessions")
    # Full day-by-day breakdown for traceability -stored as JSON
    breakdown_details = models.JSONField(null=True, blank=True, db_column="breakdown_details")
    generated_at = models.DateTimeField(auto_now_add=True, db_column="generated_at")
    emailed_at = models.DateTimeField(null=True, blank=True, db_column="emailed_at")
    # Same convention as Payroll.period_start/period_end -see that field's
    # docstring. NULL for staff and legacy production slips.
    period_start = models.DateField(null=True, blank=True, db_column="period_start")
    period_end = models.DateField(null=True, blank=True, db_column="period_end")

    class Meta:
        db_table = "salary_slips"
        unique_together = [("employee", "month", "year", "week_number")]
        constraints = [
            models.UniqueConstraint(
                fields=["employee", "period_start", "period_end"],
                condition=models.Q(period_start__isnull=False),
                name="uniq_salary_slip_employee_period",
            ),
        ]


class SessionConfig(models.Model):
    name = models.TextField()
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    # Minimum checkout time for the session to be counted as completed.
    # Morning session: 12:40 (must leave after morning ends).
    # Afternoon session: 17:30 (must stay until at least 5:30 PM).
    minimum_checkout_time = models.TimeField(null=True, blank=True, db_column="minimum_checkout_time")
    pay_amount = models.DecimalField(max_digits=8, decimal_places=2, db_column="pay_amount")
    is_overtime = models.BooleanField(default=False, db_column="is_overtime")
    order = models.IntegerField(default=0)

    class Meta:
        db_table = "session_configs"
        ordering = ["order"]


class WorkSession(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="work_sessions",
    )
    date = models.DateField()
    session_config = models.ForeignKey(
        SessionConfig, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="session_config_id", related_name="work_sessions",
    )
    session_name = models.TextField(db_column="session_name")
    check_in = models.TimeField(db_column="check_in")
    check_out = models.TimeField(db_column="check_out")
    hours_worked = models.DecimalField(max_digits=5, decimal_places=2, db_column="hours_worked")
    session_amount = models.DecimalField(max_digits=8, decimal_places=2, db_column="session_amount")
    is_overtime = models.BooleanField(default=False, db_column="is_overtime")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "work_sessions"
        ordering = ["date", "check_in"]


class Payroll(models.Model):
    SALARY_MODE_MONTHLY = "monthly"
    SALARY_MODE_SESSION = "session"
    SALARY_MODE_SHIFT = "shift"
    MODE_CHOICES = [
        (SALARY_MODE_MONTHLY, "Monthly"),
        (SALARY_MODE_SESSION, "Session-based"),
        (SALARY_MODE_SHIFT, "Shift-based (Production)"),
    ]
    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_PAID, "Paid")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="payrolls",
    )
    salary_mode = models.TextField(choices=MODE_CHOICES, db_column="salary_mode")
    month = models.IntegerField()
    year = models.IntegerField()
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    total_working_days = models.IntegerField(default=0, db_column="total_working_days")
    present_days = models.DecimalField(max_digits=5, decimal_places=1, default=0, db_column="present_days")
    absent_days = models.DecimalField(max_digits=5, decimal_places=1, default=0, db_column="absent_days")
    completed_sessions = models.IntegerField(default=0, db_column="completed_sessions")
    ot_hours = models.DecimalField(max_digits=5, decimal_places=2, default=0, db_column="ot_hours")
    ot_amount = models.DecimalField(max_digits=8, decimal_places=2, default=0, db_column="ot_amount")
    base_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="base_salary")
    gross_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="gross_salary")
    deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    bonus = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    final_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="final_salary")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    notes = models.TextField(null=True, blank=True)
    # Production-only, configurable-period payroll (see production_period.py).
    # NULL for staff rows and for legacy week_number-based production rows —
    # period_start IS NOT NULL is the discriminator for "new-style" rows.
    # week_number stays null on these; month/year are set from period_end
    # for cross-referencing (advance repayments, reporting) only, not as
    # the source of truth for the date range.
    period_start = models.DateField(null=True, blank=True, db_column="period_start")
    period_end = models.DateField(null=True, blank=True, db_column="period_end")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payrolls"
        unique_together = [("employee", "month", "year", "week_number")]
        constraints = [
            models.UniqueConstraint(
                fields=["employee", "period_start", "period_end"],
                condition=models.Q(period_start__isnull=False),
                name="uniq_payroll_employee_period",
            ),
        ]


def _default_late_deduction_slabs() -> list[dict]:
    """
    Seeds the late-deduction table with the formula that was hardcoded in
    payroll_views.py before this became configurable: every 3 billable
    lates cost a quarter shift. Expressed as explicit thresholds so HR can
    edit any individual step without touching code.

    Covers up to 30 billable lates -more than a full month of working
    days -after which the last row's value holds (see
    late_shift_deduction() in payroll_views.py).
    """
    return [
        {"fromLates": n, "deductionShifts": round(n / 3 * 0.25, 2)}
        for n in range(3, 31, 3)
    ]


class PayrollSettings(models.Model):
    """Singleton -always fetch/update the row with pk=1."""
    # 0 means "do not deduct" -default off so HR explicitly enables

    # ── Company profile (drives branding across the whole portal) ─────────
    company_name = models.TextField(default="UKTextiles", db_column="company_name")
    company_tagline = models.TextField(default="Garments Manufacturing Excellence", db_column="company_tagline")
    company_phone = models.TextField(blank=True, default="", db_column="company_phone")
    company_email = models.TextField(blank=True, default="", db_column="company_email")
    company_website = models.TextField(blank=True, default="", db_column="company_website")
    company_gstin = models.TextField(blank=True, default="", db_column="company_gstin")
    company_pan = models.TextField(blank=True, default="", db_column="company_pan")
    company_address = models.TextField(blank=True, default="", db_column="company_address")
    company_registration = models.TextField(blank=True, default="", db_column="company_registration")

    # ── Staff deductions ──────────────────────────────────────────────────
    pf_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="pf_rate", help_text="Staff employee PF % (e.g. 12). 0 = disabled."
    )
    esi_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="esi_rate", help_text="Staff employee ESI % (e.g. 0.75). 0 = disabled."
    )
    esi_applicable_below = models.DecimalField(
        max_digits=10, decimal_places=2, default=21000,
        db_column="esi_applicable_below",
        help_text="Staff: ESI applies only when full monthly salary is below this amount."
    )

    # ── Production deductions ─────────────────────────────────────────────
    prod_pf_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="prod_pf_rate", help_text="Production employee PF % (e.g. 12). 0 = disabled."
    )
    prod_esi_rate = models.DecimalField(
        max_digits=5, decimal_places=2, default=0,
        db_column="prod_esi_rate", help_text="Production employee ESI % (e.g. 0.75). 0 = disabled."
    )
    prod_esi_applicable_below = models.DecimalField(
        max_digits=10, decimal_places=2, default=21000,
        db_column="prod_esi_applicable_below",
        help_text="Production: ESI applies only when monthly-equivalent earnings are below this amount."
    )

    # ── Compensation (CTC breakdown) ─────────────────────────────────────
    # Feeds ONLY the read-only Compensation page's CTC breakdown -defaults
    # match the 50/20 split _generate_staff_payroll already hardcodes, so
    # nothing about actual payroll generation changes unless these are
    # edited on purpose.
    basic_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=50,
        db_column="basic_percent",
        help_text="% of salary treated as Basic for the Compensation page's CTC breakdown. Does not affect payroll generation."
    )
    hra_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=20,
        db_column="hra_percent",
        help_text="% of salary treated as HRA for the Compensation page's CTC breakdown. Does not affect payroll generation."
    )

    # ── Statutory Bonus (Payment of Bonus Act, 1965) ─────────────────────
    bonus_percent = models.DecimalField(
        max_digits=5, decimal_places=2, default=Decimal("8.33"),
        db_column="bonus_percent",
        help_text="Statutory bonus % applied to eligible wages (Act range: 8.33 min, 20 max)."
    )
    bonus_wage_ceiling = models.DecimalField(
        max_digits=10, decimal_places=2, default=7000,
        db_column="bonus_wage_ceiling",
        help_text="Monthly wage ceiling used in the bonus calculation base -min(basic, this) per record."
    )
    bonus_eligibility_ceiling = models.DecimalField(
        max_digits=10, decimal_places=2, default=21000,
        db_column="bonus_eligibility_ceiling",
        help_text="Employees earning at or below this monthly wage are bonus-eligible."
    )
    bonus_fy_start_month = models.IntegerField(
        default=4, db_column="bonus_fy_start_month",
        help_text="Financial year start month (1-12). Default 4 = April (Indian FY)."
    )

    # ── General ───────────────────────────────────────────────────────────
    pay_day = models.IntegerField(
        default=5, db_column="pay_day",
        help_text="Day of month when salaries are disbursed."
    )
    production_pay_type = models.TextField(
        default="biweekly", db_column="production_pay_type",
        help_text="biweekly or monthly"
    )
    default_salary_per_shift = models.DecimalField(
        max_digits=8, decimal_places=2, default=0, db_column="default_salary_per_shift",
        help_text="Pre-filled Salary Per Shift for new production employees. 0 = no default.",
    )

    # ── Production payroll period (Settings → Payroll → Production) ────────
    # Replaces the old hardcoded 1st-15th/16th-end biweekly split. Two
    # independent axes — see production_period.py::resolve_production_period
    # for the actual boundary math. `production_pay_type` above predates
    # this and was never wired into the engine — left in place (harmless)
    # but fully superseded by the fields below.
    PERIOD_FREQ_WEEKLY = "weekly"
    PERIOD_FREQ_2WEEKS = "2weeks"
    PERIOD_FREQ_3WEEKS = "3weeks"
    PERIOD_FREQ_MONTHLY = "monthly"
    PERIOD_FREQ_CHOICES = [
        (PERIOD_FREQ_WEEKLY, "Weekly"), (PERIOD_FREQ_2WEEKS, "2 Weeks"),
        (PERIOD_FREQ_3WEEKS, "3 Weeks"), (PERIOD_FREQ_MONTHLY, "Monthly"),
    ]
    PERIOD_STYLE_CALENDAR_MONTH = "calendar_month"
    PERIOD_STYLE_WEEKDAY_ANCHORED = "weekday_anchored"
    PERIOD_STYLE_CUSTOM_RECURRING = "custom_recurring"
    PERIOD_STYLE_CHOICES = [
        (PERIOD_STYLE_CALENDAR_MONTH, "Calendar Month Anchored"),
        (PERIOD_STYLE_WEEKDAY_ANCHORED, "Weekday Anchored (Rolling)"),
        (PERIOD_STYLE_CUSTOM_RECURRING, "Custom Recurring"),
    ]
    WEEKDAY_ANCHOR_MON_SAT = "mon_sat"
    WEEKDAY_ANCHOR_SUN_SAT = "sun_sat"
    WEEKDAY_ANCHOR_CHOICES = [
        (WEEKDAY_ANCHOR_MON_SAT, "Monday–Saturday"), (WEEKDAY_ANCHOR_SUN_SAT, "Sunday–Saturday"),
    ]
    prod_period_frequency = models.TextField(
        choices=PERIOD_FREQ_CHOICES, default=PERIOD_FREQ_2WEEKS, db_column="prod_period_frequency",
        help_text="How often production payroll periods repeat.",
    )
    prod_period_style = models.TextField(
        choices=PERIOD_STYLE_CHOICES, default=PERIOD_STYLE_CALENDAR_MONTH, db_column="prod_period_style",
        help_text="How period boundaries are anchored. Monthly frequency is only valid with calendar_month style.",
    )
    prod_period_weekday_anchor = models.TextField(
        choices=WEEKDAY_ANCHOR_CHOICES, null=True, blank=True, db_column="prod_period_weekday_anchor",
        help_text="Only used when prod_period_style = weekday_anchored.",
    )
    prod_period_anchor_date = models.DateField(
        null=True, blank=True, db_column="prod_period_anchor_date",
        help_text="Start date of the first period for weekday_anchored/custom_recurring styles. Ignored for calendar_month.",
    )
    prod_period_custom_days = models.IntegerField(
        null=True, blank=True, db_column="prod_period_custom_days",
        help_text="Fixed day-length of each period. Only used when prod_period_style = custom_recurring.",
    )

    # ── Production attendance mode + Late Detection (Settings → Payroll →
    # Production) ─────────────────────────────────────────────────────────
    # Entirely independent of the staff attendance_mode/late_* fields above,
    # and additive to production payroll: shifts_earned/gross pay is still
    # computed exactly as before (ProductionShiftConfig/ProductionShiftSegment,
    # untouched) -this only adds an optional late-arrival deduction on top,
    # keyed off the employee's Manage-Shift-assigned Production ShiftTemplate
    # (not ProductionShiftConfig), gated entirely behind
    # prod_late_detection_enabled so it's a no-op until HR opts in.
    prod_attendance_mode = models.TextField(
        choices=[("simple", "Simple"), ("strict", "Strict")],
        default="strict", db_column="prod_attendance_mode",
        help_text=(
            "Governs the Production Late Detection check below only -does "
            "not affect shifts-earned/pay math. Simple: late if the day's "
            "first punch is after (assigned shift start + grace). Strict: "
            "also flags leaving before (assigned shift end - grace) as late."
        ),
    )
    prod_late_detection_enabled = models.BooleanField(
        default=False, db_column="prod_late_detection_enabled",
        help_text="Off by default -production payroll ignores lateness entirely until enabled.",
    )
    prod_late_free_allowance = models.IntegerField(
        default=3, db_column="prod_late_free_allowance",
        help_text="Free late occurrences allowed per employee per period before any shift deduction applies.",
    )
    prod_late_deduction_slabs = models.JSONField(
        default=list, blank=True, db_column="prod_late_deduction_slabs",
        help_text=(
            "Same shape/semantics as late_deduction_slabs (staff), applied to "
            "the Production Late pool instead. Empty by default -no "
            "deduction until HR configures rows here."
        ),
    )

    slip_company_name = models.TextField(default="UK TEXTILES - H.O", db_column="slip_company_name")
    slip_company_address = models.TextField(default="TIRUPUR", db_column="slip_company_address")
    min_wage_rate = models.DecimalField(max_digits=10, decimal_places=2, default=0, db_column="min_wage_rate")
    signature_image = models.TextField(null=True, blank=True, db_column="signature_image")
    company_logo = models.TextField(null=True, blank=True, db_column="company_logo")
    authorized_signature = models.TextField(null=True, blank=True, db_column="authorized_signature")

    # ── Attendance calculation mode ───────────────────────────────────────
    # strict = existing 4-punch engine (lunch delays, return-late detection)
    # simple = morning punch + evening punch only; first punch after the
    #          half-shift cutoff = half shift; no lunch tracking
    attendance_mode = models.TextField(default="strict", db_column="attendance_mode")
    simple_half_shift_cutoff = models.TimeField(
        default="13:30", db_column="simple_half_shift_cutoff",
        help_text="Simple mode: first punch after this time = half shift."
    )
    shift_punctuality_window_minutes = models.IntegerField(
        default=60, db_column="shift_punctuality_window_minutes",
        help_text=(
            "Staff only. Even with a first+last punch pair, Full Shift also "
            "requires the first punch within this many minutes of the "
            "employee's assigned shift start time, and the last punch "
            "within the same window of the assigned shift end time -"
            "otherwise the day moves into the Permission zone (see "
            "permission_window_minutes) or, past that, is capped at Half "
            "Shift. Employees with no assigned shift have no reference to "
            "check against, so this never applies to them."
        ),
    )

    # ── Auto-Permission zone (staff, arrival + departure) ─────────────────
    # Inserted between the existing Late/Half-Shift boundary
    # (shift_punctuality_window_minutes) and a new, farther-out Half-Shift
    # boundary: a first/last punch landing past the punctuality window but
    # still within this many EXTRA minutes is auto-detected as "Permission"
    # (not Half Shift) -purely from punch timing, independent of whether an
    # EmployeePermission was ever submitted (see permission_*_with_request
    # on AttendanceDayRecord for that separate axis). Past this extra window,
    # the day is Half Shift, same as before this feature existed.
    permission_window_minutes = models.IntegerField(
        default=60, db_column="permission_window_minutes",
        help_text=(
            "Staff only. Extra minutes past shift_punctuality_window_minutes "
            "(on either the arrival or departure edge) during which a punch "
            "is auto-detected as Permission instead of Half Shift. Past "
            "this window too, the day is Half Shift."
        ),
    )
    max_permissions_per_day = models.IntegerField(
        default=1, db_column="max_permissions_per_day",
        help_text=(
            "Staff only. Maximum shift edges (morning arrival, lunch return, "
            "departure) per day that may resolve to Permission status. Any "
            "edge beyond this on the same day escalates to Half Shift."
        ),
    )
    max_permissions_per_week = models.IntegerField(
        default=2, db_column="max_permissions_per_week",
        help_text=(
            "Staff only. Maximum Permission-zone edges per ISO week (Mon-Sun) "
            "across all days. Once exhausted, further edges that week "
            "escalate to Half Shift even if under the daily cap."
        ),
    )

    # ── Half Shift late reference (staff) ─────────────────────────────────
    # A day capped at Half Shift is only additionally flagged Late when the
    # first punch is strictly AFTER this time -an afternoon half-shift that
    # starts on time is not "late", it's just a half day. Was a hardcoded
    # 14:30 constant in shift_engine.py before this became configurable;
    # the default preserves that exact behavior.
    half_shift_late_reference_time = models.TimeField(
        default="14:30", db_column="half_shift_late_reference_time",
        help_text=(
            "Staff only. On a Half Shift day, the first punch is flagged Late "
            "only if it is strictly after this time. Compared at minute "
            "granularity (seconds ignored)."
        ),
    )

    # ── Late Detection policy (staff payroll) ─────────────────────────────
    # Lates and approved Permissions share ONE combined monthly pool. The
    # first `late_free_allowance` of that pool are free; everything beyond
    # it is "billable" and priced by the slab table below.
    late_free_allowance = models.IntegerField(
        default=3, db_column="late_free_allowance",
        help_text=(
            "Free lates + permissions allowed per employee per month before "
            "any shift deduction applies. Lates and approved Permission "
            "requests draw on this same shared pool."
        ),
    )
    # Ordered threshold table: [{"fromLates": N, "deductionShifts": D}, ...]
    # The engine picks the highest row whose fromLates <= billable lates and
    # applies that row's deductionShifts. Rows beyond the last one hold at
    # the last row's value. The default seeds the old hardcoded formula
    # (every 3 billable lates = 0.25 shift) across the full range a calendar
    # month can produce, so behavior is unchanged out of the box.
    late_deduction_slabs = models.JSONField(
        default=_default_late_deduction_slabs, blank=True,
        db_column="late_deduction_slabs",
        help_text=(
            "Shift deduction thresholds. Each row: fromLates (billable late "
            "count reached) -> deductionShifts (shifts cut). Highest matching "
            "row wins; the last row holds for anything beyond it."
        ),
    )

    # ── Without Permission policy (staff payroll) -separate pool ─────────
    # Counts auto-detected Permission-zone edges (morning arrival, lunch
    # return, departure) that had NO approved EmployeePermission covering
    # them (see AttendanceDayRecord.permission_*_with_request). Independent
    # from the Late Attendance pool above -an occurrence here does not also
    # draw down late_free_allowance, and vice versa. Ships with an empty
    # slab table (zero deduction) so this detection is purely informational
    # until HR deliberately opts in here.
    without_permission_free_allowance = models.IntegerField(
        default=0, db_column="without_permission_free_allowance",
        help_text=(
            "Free Permission-zone-without-a-submitted-request occurrences "
            "allowed per employee per month before any shift deduction "
            "applies."
        ),
    )
    without_permission_deduction_slabs = models.JSONField(
        default=list, blank=True,
        db_column="without_permission_deduction_slabs",
        help_text=(
            "Same shape/semantics as late_deduction_slabs, applied to the "
            "Without Permission pool instead. Empty by default -no "
            "deduction until HR configures rows here."
        ),
    )

    # ── Afternoon (Night) Late / lunch-return zone (staff, strict mode) ───
    # Strict mode only -simple mode has no punch2/punch3 (lunch) concept.
    # Mirrors the arrival/departure zone chain above but anchored to
    # (punch2 + lunch_duration_minutes) instead of a fixed shift edge, since
    # the lunch window is a DURATION, not a time-of-day. Widths are kept
    # independent of the arrival/departure window so HR can tune the lunch
    # policy separately.
    afternoon_late_window_minutes = models.IntegerField(
        default=60, db_column="afternoon_late_window_minutes",
        help_text=(
            "Strict mode only. Minutes past the lunch-return deadline "
            "(punch2 + lunch_duration_minutes) during which a late return "
            "is flagged Night Late but does not affect shift value. Beyond "
            "this, the afternoon Permission zone begins."
        ),
    )
    afternoon_permission_window_minutes = models.IntegerField(
        default=60, db_column="afternoon_permission_window_minutes",
        help_text=(
            "Strict mode only. Extra minutes past afternoon_late_window_"
            "minutes during which a late lunch return is auto-detected as "
            "Permission. Beyond this window, see "
            "afternoon_late_can_cause_half_shift."
        ),
    )
    afternoon_late_can_cause_half_shift = models.BooleanField(
        default=True, db_column="afternoon_late_can_cause_half_shift",
        help_text=(
            "Strict mode only. When on, a lunch return beyond the afternoon "
            "Late + Permission windows caps the day at Half Shift, the same "
            "way an arrival/departure edge already can. When off, a late "
            "lunch return is only ever flagged (never demotes shift value) "
            "-matches behavior before this feature existed."
        ),
    )

    # ── OT (Overtime) compensation detection ──────────────────────────────
    # Off by default -no employee is auto-flagged for OT until HR opts in
    # here. See backend/api/overtime.py for the detection engine and
    # OvertimeRecord for the announced result. compensation_type is a
    # single company-wide choice (HR-controlled, never per-employee) per the
    # user's explicit requirement that employees cannot choose or
    # self-assign compensation.
    ot_detection_enabled = models.BooleanField(
        default=False, db_column="ot_detection_enabled",
        help_text="Staff only. Off by default -OT is never detected until HR enables this.",
    )
    ot_threshold_minutes = models.IntegerField(
        default=60, db_column="ot_threshold_minutes",
        help_text="Minutes worked past the assigned shift's end time before a day is OT-eligible.",
    )
    ot_compensation_type = models.TextField(
        default="pay", db_column="ot_compensation_type",
        help_text=(
            "Company-wide default: 'pay' (one day's equivalent salary added to "
            "the next payroll run as OT) or 'relaxation' (a paid Alternative "
            "Day credit HR can redeem later). Snapshotted onto each "
            "OvertimeRecord at announce time; HR may override per-batch."
        ),
    )

    # ── Default timings for NEW shifts (Manage Shift inherits these) ───────
    # Start/end time is deliberately NOT here -Manage Shift owns that
    # per-shift and always has; duplicating it here would just invite drift
    # between "the default" and "what Manage Shift actually shows".
    default_shift_grace_minutes = models.IntegerField(default=15, db_column="default_shift_grace_minutes")
    default_shift_first_half_end = models.TimeField(default="13:30", db_column="default_shift_first_half_end")
    default_shift_lunch_duration_minutes = models.IntegerField(default=60, db_column="default_shift_lunch_duration_minutes")
    default_shift_lunch_grace_minutes = models.IntegerField(default=10, db_column="default_shift_lunch_grace_minutes")

    # ── Cross-midnight punch reattribution (staff only) ────────────────────
    # A forgotten evening exit punch is sometimes made hours late, after
    # midnight -the biometric device stamps it under the NEXT calendar
    # date, which (without this) gets misread as tomorrow's first punch,
    # shifting all of tomorrow's real punches down a slot. These two
    # settings jointly define the reattribution window; setting either to
    # 0 disables it (last_punch_post_shift_grace_hours=0 turns the window
    # itself off entirely; first_punch_pre_shift_buffer_hours=0 just
    # removes the protective cap, letting the grace window reach all the
    # way to the next shift's start time). See shift_engine.py's
    # _cross_midnight_claim_cutoff for exactly how these combine.
    last_punch_post_shift_grace_hours = models.DecimalField(
        max_digits=4, decimal_places=1, default=Decimal("9.0"),
        db_column="last_punch_post_shift_grace_hours",
        help_text=(
            "Staff only. A punch on the NEXT calendar date, up to this many "
            "hours after the shift's end time, is treated as this day's "
            "forgotten last-out instead of tomorrow's first punch -e.g. 9 "
            "hours after a 20:00 end covers a punch made as late as 05:00. "
            "Only applies when this day doesn't already have a punch at or "
            "after its own shift end. Set to 0 to disable."
        ),
    )
    first_punch_pre_shift_buffer_hours = models.DecimalField(
        max_digits=4, decimal_places=1, default=Decimal("2.0"),
        db_column="first_punch_pre_shift_buffer_hours",
        help_text=(
            "Staff only. Protects a genuinely early arrival from being "
            "stolen by the setting above -the reattribution window above "
            "can never reach closer than this many hours before the next "
            "day's own shift start time. Set to 0 to remove this cap."
        ),
    )

    # ── Production attendance windows (1.5-shift day) ─────────────────────
    prod_first_half_start = models.TimeField(default="08:30", db_column="prod_first_half_start")
    prod_first_half_end   = models.TimeField(default="12:30", db_column="prod_first_half_end")
    prod_second_half_start = models.TimeField(default="13:30", db_column="prod_second_half_start")
    prod_second_half_end   = models.TimeField(default="17:30", db_column="prod_second_half_end")
    prod_extra_start = models.TimeField(default="17:50", db_column="prod_extra_start")
    prod_extra_end   = models.TimeField(default="20:00", db_column="prod_extra_end")

    # ── Production PF/EF salary-range rules ────────────────────────────────
    # list of {"label": str, "minSalary": num, "maxSalary": num, "pfRate": num, "efRate": num}
    # When enabled, the rule matching the employee's monthly-equivalent earnings
    # takes precedence over the flat prod_pf_rate / prod_esi_rate.
    prod_pf_ef_enabled = models.BooleanField(default=False, db_column="prod_pf_ef_enabled")
    prod_pf_ef_rules = models.JSONField(default=list, blank=True, db_column="prod_pf_ef_rules")

    # ── Feature toggles (Settings page master switches) ────────────────────
    # Flat PF/ESI payroll rules per employee class. Disabled by default —
    # when off, the flat rates above are NOT applied even if non-zero.
    # (Production salary-range rules keep their own prod_pf_ef_enabled toggle.)
    staff_payroll_rules_enabled = models.BooleanField(default=False, db_column="staff_payroll_rules_enabled")
    prod_payroll_rules_enabled = models.BooleanField(default=False, db_column="prod_payroll_rules_enabled")
    # Compensation feature master switch (CTC Breakdown + OT Detection +
    # Compensation Leave + History & Reports -the whole /hr/compensation
    # page). Checked at a single choke point everywhere it matters
    # (compensation_views.py's @require_compensation_enabled, attendance_
    # final.py's _compensation_day_for, payroll_views.py's OT-pay block,
    # overtime.py's detect_overtime_for_month) -a toggle that only hides a
    # sidebar entry while the underlying calculations keep running regardless
    # is a bug, not a feature, so this one is wired to genuinely disable
    # everything at once from day one. Sub-settings (ot_detection_enabled,
    # ot_threshold_minutes, ot_compensation_type) stay independent finer-
    # grained controls underneath this master switch -this is default True
    # since the pages are already live; HR turns it off explicitly to
    # postpone the feature.
    compensation_feature_enabled = models.BooleanField(default=True, db_column="compensation_feature_enabled")

    # ── Database backup ─────────────────────────────────────────────────────
    backup_directory = models.TextField(blank=True, default="", db_column="backup_directory")

    # ── SMTP / Email ──────────────────────────────────────────────────────
    smtp_host = models.TextField(default="smtp.gmail.com", db_column="smtp_host")
    smtp_port = models.IntegerField(default=587, db_column="smtp_port")
    smtp_username = models.TextField(blank=True, default="", db_column="smtp_username")
    smtp_password = models.TextField(blank=True, default="", db_column="smtp_password")
    smtp_from_email = models.TextField(blank=True, default="", db_column="smtp_from_email")
    smtp_from_name = models.TextField(default="UKTextiles HR", db_column="smtp_from_name")

    # ── Appearance / Theme ────────────────────────────────────────────────
    # Org-wide, not per-user: whichever theme is active here is what every HR
    # portal user sees. Key must match one of the ids in the frontend's
    # src/lib/themes.ts (which also owns the actual colour values -only the
    # selection and any per-token overrides live in the database).
    theme_name = models.TextField(default="default", db_column="theme_name")
    # Optional per-token overrides applied on top of the selected theme, as
    # {"--primary": "201 100% 29%", ...}. Empty = use the theme unmodified.
    theme_custom = models.JSONField(default=dict, blank=True, db_column="theme_custom")

    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "payroll_settings"

    @classmethod
    def get(cls) -> "PayrollSettings":
        obj, created = cls.objects.get_or_create(pk=1)
        if created:
            # get_or_create's freshly-inserted instance keeps its Python-level
            # field defaults verbatim (e.g. TimeField(default="14:30") stays
            # the literal string "14:30", not a time object) until reloaded
            # from the DB, which runs it through the field's from_db
            # conversion. Every caller that reads a Time/Date-typed field off
            # a first-ever singleton row (a brand-new install, or a test's
            # rolled-back-clean DB) would otherwise get a raw string and
            # crash the first time that value reaches a time-arithmetic call
            # (e.g. half_shift_late_reference_time in shift_engine.py).
            obj.refresh_from_db()
        return obj


class BranchSettingsOverride(models.Model):
    """One BRANCH's Settings, layered over the universal row.

    Keyed on Branch rather than on the login, because a branch can have
    several credentials -different people, or just different ways in -and
    they must all see and compute with the same numbers. Two logins on one
    unit disagreeing about the PF rate would mean the same employee's salary
    depended on who pressed Generate.

    Admins edit PayrollSettings (pk=1) itself, so their saves are universal
    and become every branch's default. A branch stores only the fields it has
    actually changed, so anything it leaves alone keeps tracking the
    universal value and picks up the Admin's later edits automatically.

    Stored as a JSON field name -> value map rather than ~90 nullable mirror
    columns, so adding a setting to PayrollSettings needs no migration here.

    Resolution differs by purpose, and the distinction matters:
      * the Settings PAGE resolves from the logged-in user's branch;
      * payroll and attendance resolve from the EMPLOYEE's branch, so a run
        started from the Admin page produces exactly what the branch login
        would have produced.
    Engine and background paths (attendance_final, shift_engine,
    backup_scheduler) have neither, and read the universal row.
    """
    branch = models.OneToOneField(
        "Branch", on_delete=models.CASCADE,
        db_column="branch_id", related_name="settings_override",
    )
    #: {model_field_name: value} -only the fields this branch has changed.
    overrides = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "branch_settings_overrides"

    def __str__(self):
        return f"Settings override for branch {self.branch_id} ({len(self.overrides or {})} fields)"


class SalaryRecord(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="salary_records"
    )
    month = models.IntegerField()
    year = models.IntegerField()
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    type = models.TextField(default="monthly")
    week_number = models.IntegerField(null=True, blank=True, db_column="week_number")
    status = models.TextField(default="pending")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "salary_records"


# ──────────────────────────────────────────────
#  Promotion & Increment
# ──────────────────────────────────────────────

class Promotion(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="promotions"
    )
    previous_department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="previous_department_id", related_name="+",
    )
    previous_designation = models.ForeignKey(
        Designation, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="previous_designation_id", related_name="+",
    )
    new_department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="new_department_id", related_name="+",
    )
    new_designation = models.ForeignKey(
        Designation, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="new_designation_id", related_name="+",
    )
    effective_date = models.DateField(db_column="effective_date")
    notes = models.TextField(null=True, blank=True)
    promoted_by = models.TextField(null=True, blank=True, db_column="promoted_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "promotions"
        ordering = ["-effective_date", "-created_at"]


class SalaryIncrement(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="increments"
    )
    previous_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="previous_salary")
    new_salary = models.DecimalField(max_digits=10, decimal_places=2, db_column="new_salary")
    percent = models.DecimalField(
        max_digits=6, decimal_places=2, db_column="percent",
        help_text="Increment percentage applied (e.g. 10.00)."
    )
    effective_date = models.DateField(db_column="effective_date")
    notes = models.TextField(null=True, blank=True)
    added_by = models.TextField(null=True, blank=True, db_column="added_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "salary_increments"
        ordering = ["-effective_date", "-created_at"]


class Bonus(models.Model):
    """One employee's statutory bonus (Payment of Bonus Act, 1965) for one
    financial year -see growth_views.py::_calculate_bonus_for_employee for
    how calculation_base/bonus_amount are derived from that employee's
    SalarySlip history for the year.
    """
    STATUS_CALCULATED = "calculated"
    STATUS_APPROVED = "approved"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [
        (STATUS_CALCULATED, "Calculated"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_PAID, "Paid"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="bonuses"
    )
    financial_year = models.TextField(db_column="financial_year")  # e.g. "2025-26"
    # Number of SalarySlip rows found in the FY window and used to build
    # calculation_base -shown in the UI so HR can see how complete the
    # underlying payroll data was for this employee this year.
    records_considered = models.IntegerField(db_column="records_considered")
    calculation_base = models.DecimalField(
        max_digits=10, decimal_places=2, db_column="calculation_base",
        help_text="Sum of min(basic, bonus_wage_ceiling) across the FY's salary slips."
    )
    bonus_percent_applied = models.DecimalField(max_digits=5, decimal_places=2, db_column="bonus_percent_applied")
    bonus_amount = models.DecimalField(max_digits=10, decimal_places=2, db_column="bonus_amount")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_CALCULATED)
    notes = models.TextField(null=True, blank=True)
    computed_by = models.TextField(null=True, blank=True, db_column="computed_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "bonuses"
        unique_together = [("employee", "financial_year")]
        ordering = ["-created_at"]


# ──────────────────────────────────────────────
#  Compensation: OT detection + Compensation-Leave announcements
# ──────────────────────────────────────────────
#
# Two independent HR-announced flows (see backend/api/overtime.py and
# compensation_views.py):
#   1. OvertimeRecord -auto-detected (worked past shift end), HR reviews and
#      announces Pay or Relaxation. Nothing is paid/credited until announced.
#   2. CompensationDayAnnouncement -HR declares a festival/special day for
#      specific employees/branch/department; actual punches still decide
#      Full vs Half that day (see attendance_final.py's compensation-day
#      exemption) -a compensation day never auto-grants Full Day.

class OvertimeRecord(models.Model):
    STATUS_DETECTED = "detected"
    STATUS_ANNOUNCED = "announced"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_DETECTED, "Detected"),
        (STATUS_ANNOUNCED, "Announced"),
        (STATUS_REJECTED, "Rejected"),
    ]
    TYPE_PAY = "pay"
    TYPE_RELAXATION = "relaxation"
    TYPE_CHOICES = [(TYPE_PAY, "Pay"), (TYPE_RELAXATION, "Relaxation")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="overtime_records",
    )
    date = models.DateField()
    shift_end_time = models.TimeField(null=True, blank=True, db_column="shift_end_time")
    last_punch_out = models.TimeField(db_column="last_punch_out")
    ot_minutes = models.IntegerField(db_column="ot_minutes")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_DETECTED)
    # Snapshot of PayrollSettings.ot_compensation_type at the moment HR
    # announces this record -so a later Settings change never retroactively
    # changes an already-announced record's compensation type.
    compensation_type = models.TextField(choices=TYPE_CHOICES, null=True, blank=True, db_column="compensation_type")
    announced_by = models.TextField(null=True, blank=True, db_column="announced_by")
    announced_at = models.DateTimeField(null=True, blank=True, db_column="announced_at")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "overtime_records"
        unique_together = [["employee", "date"]]
        ordering = ["-date"]


class CompensationLeaveCredit(models.Model):
    """One credited Alternative Day off, earned from an announced
    Relaxation-type OvertimeRecord. Redeemed by HR against a specific date
    on the employee's behalf (see compensation_views.redeem_credit) -this
    intentionally reuses casual_leave_views._write_attendance_for_cl's
    hardcode-present pattern, since a redeemed day is a genuine day off, not
    a modified work day (contrast with CompensationDayAnnouncement below)."""
    STATUS_AVAILABLE = "available"
    STATUS_USED = "used"
    STATUS_CHOICES = [(STATUS_AVAILABLE, "Available"), (STATUS_USED, "Used")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="compensation_credits",
    )
    source_overtime_record = models.ForeignKey(
        OvertimeRecord, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="source_overtime_record_id", related_name="credits",
    )
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_AVAILABLE)
    used_date = models.DateField(null=True, blank=True, db_column="used_date")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "compensation_leave_credits"
        ordering = ["-created_at"]


class CompensationDayAnnouncement(models.Model):
    """HR-declared compensation day (festival/special day). Scoped by an
    explicit employee list and/or branch/department (Holiday's nullable-FK
    convention -null means unscoped on that axis). `leave_until_time` null
    means the whole day is exempted from Late/Permission detection; a time
    means only that early-release edge is exempted -see attendance_final.py's
    _compensation_day_for / its callers for how this is applied. Never
    changes shifts_earned by itself -Full vs Half is still decided from real
    punches, against `leave_until_time` as the effective shift end when set."""
    date = models.DateField()
    leave_until_time = models.TimeField(null=True, blank=True, db_column="leave_until_time")
    branch = models.ForeignKey(
        "Branch", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="compensation_days",
    )
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="compensation_days",
    )
    employees = models.ManyToManyField(
        Employee, blank=True, related_name="compensation_day_announcements",
    )
    reason = models.TextField(null=True, blank=True)
    announced_by = models.TextField(null=True, blank=True, db_column="announced_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "compensation_day_announcements"
        ordering = ["-date"]


# ──────────────────────────────────────────────
#  Production Shift Workflow (separate from staff)
# ──────────────────────────────────────────────

class ProductionShiftConfig(models.Model):
    """
    Singleton. Reference punch times for the production 4-punch day and the
    grace window used when checking segment coverage. Gender-agnostic -a
    single config applies to every production employee.
    """
    punch1_time = models.TimeField(default=time(8, 30), db_column="punch1_time", help_text="Arrival")
    punch2_time = models.TimeField(default=time(12, 45), db_column="punch2_time", help_text="Lunch out")
    punch3_time = models.TimeField(default=time(13, 30), db_column="punch3_time", help_text="Lunch return")
    punch4_time = models.TimeField(default=time(20, 0), db_column="punch4_time", help_text="Departure")
    grace_minutes = models.IntegerField(default=10, db_column="grace_minutes")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "production_shift_config"

    @classmethod
    def get(cls) -> "ProductionShiftConfig":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class ProductionShiftSegment(models.Model):
    """
    Ordered, dynamic list of shift-value segments for production attendance.
    Default (1.50-shift day): 4 x 0.25 covering 8:30-12:45 & 13:30-17:30,
    plus 0.50 for 17:30-20:00. Fully editable from Settings / Shift Management.
    """
    label = models.TextField()
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    shift_value = models.DecimalField(max_digits=4, decimal_places=2, db_column="shift_value")
    order = models.IntegerField(default=0)
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "production_shift_segments"
        ordering = ["order", "id"]
