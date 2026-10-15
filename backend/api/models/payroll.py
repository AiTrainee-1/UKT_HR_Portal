"""Payroll runs, salary slips, advances, settings, increments/bonuses, overtime and compensation."""

from datetime import time
from decimal import Decimal
from django.db import models

from ..clock import ist_today
from ..production_cycles import CYCLE_CHOICES
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
    # The production pay cycle (Weekly / BiWeekly / Monthly) this slip was generated on; NULL for staff and for
    # production slips generated before the cycles existed. Same meaning as Payroll.pay_cycle.
    pay_cycle = models.TextField(choices=CYCLE_CHOICES, null=True, blank=True, db_column="pay_cycle")

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
    # The production pay cycle this row was generated on (production_cycles.py): Weekly, BiWeekly or Monthly.
    # NULL for staff rows and for production rows generated before the cycles existed; those are shown with the
    # cycle their employee is assigned to now.
    pay_cycle = models.TextField(choices=CYCLE_CHOICES, null=True, blank=True, db_column="pay_cycle")
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
    # Production pay cycles (Settings -> Production Payroll -> Weekly / BiWeekly / Monthly): {cycle: {weekStart,
    # anchorDate, lateFreeAllowance, lateSlabs}}, see production_cycles.py. Supersedes the five prod_period_* columns
    # above for production payroll (they are no longer read by it); a cycle with no late rules of its own uses the
    # shared prod_late_* values below. NULL = nothing configured yet.
    prod_cycles = models.JSONField(null=True, blank=True, db_column="prod_cycles")

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
    # simple = morning punch + evening punch only; no lunch tracking
    # Late Detection, Permission and Half-Day Detection are IDENTICAL in both.
    attendance_mode = models.TextField(default="strict", db_column="attendance_mode")
    # DEPRECATED -NOT READ BY ANY ENGINE ANY MORE. Simple mode used to call a first
    # punch after this time a half shift; Half-Day Detection (half_day_first_half_end_time /
    # half_day_second_half_start_time below) now decides Full/Half/Absent for both modes.
    # Kept only so existing rows, the settings API and old payroll breakdowns stay valid.
    simple_half_shift_cutoff = models.TimeField(
        default="13:30", db_column="simple_half_shift_cutoff",
        help_text="Simple mode: first punch after this time = half shift."
    )
    # ── Late Detection (staff): Morning Late-In / Evening Early-Out ───────
    # Two independently toggleable checks, both judged against the
    # employee's assigned shift start/end time (or, on a day with an
    # approved in-cap Permission, that day's permission-shifted effective
    # boundary -see attendance_final.py). Morning Late-In ships on since
    # every company wants it; Evening Early-Out ships off since not every
    # company checks departure time.
    #
    # db_default on every column added by this rewrite: an OLD backend
    # instance keeps running for a while during a rolling deploy (and after a
    # rollback), and it does not know these columns exist -without a
    # database-level default its INSERTs would fail once the migration ran.
    morning_late_in_enabled = models.BooleanField(
        default=True, db_default=True, db_column="morning_late_in_enabled",
        help_text="Staff only. Flag a punch after (shift start + grace) as Morning Late-In.",
    )
    evening_early_out_enabled = models.BooleanField(
        default=False, db_default=False, db_column="evening_early_out_enabled",
        help_text="Staff only. Flag a punch before (shift end - grace) as Evening Early-Out. Off by default.",
    )

    # ── Half-Day Detection (staff) ─────────────────────────────────────────
    # Replaces the old punctuality-window escalation entirely: Full/Half/
    # Absent is now decided purely by whether the employee has a punch in
    # each half's window, at these two fixed, company-wide clock times (the
    # same for every shift -not a per-shift setting, since the question
    # "did they show up at all that half" doesn't depend on their exact
    # shift timing the way lateness does). Any punch before
    # half_day_first_half_end_time counts as the whole Morning Half
    # attended (lateness within it is judged separately, by Late Detection
    # above -it never costs the half by itself); symmetrically, any punch
    # at/after half_day_second_half_start_time counts as the whole Evening
    # Half attended. Both halves attended = Full Day; one = Half Day;
    # neither = Absent. See attendance_final.py's half-day decision.
    half_day_first_half_end_time = models.TimeField(
        default="13:30", db_default=time(13, 30), db_column="half_day_first_half_end_time",
        help_text="Staff only. A punch before this time counts as the Morning Half attended.",
    )
    half_day_second_half_start_time = models.TimeField(
        default="14:30", db_default=time(14, 30), db_column="half_day_second_half_start_time",
        help_text="Staff only. A punch at or after this time counts as the Evening Half attended.",
    )

    # ── Permission policy (staff) ──────────────────────────────────────────
    # Exactly 3 Permission types (Morning Late-In, Evening Early-Out,
    # Middle One-Hour -see EmployeePermission.TYPE_CHOICES), each a fixed
    # 60 minutes. A request is never blocked by this cap -HR can still
    # approve a 4th (or later) one that month; it just stops being
    # protective: attendance_final.py only shifts that day's effective
    # boundary for an approved permission that is still within this cap
    # (counted in date order, earliest first). Beyond the cap, an approved
    # Morning-Late-In/Evening-Early-Out permission has no effect -the day
    # is judged against the plain shift time, and if that lands it in Late
    # Detection, it joins the same late_free_allowance/late_deduction_slabs
    # pool below as an ordinary unexcused occurrence. A Middle One-Hour
    # permission never shifts any boundary at all, in or out of the cap.
    permission_monthly_cap = models.IntegerField(
        default=3, db_default=3, db_column="permission_monthly_cap",
        help_text="Staff only. Approved permissions per employee per calendar month that actually protect that day.",
    )

    # ── Arrival timeline (staff) ───────────────────────────────────────────
    # How a morning arrival is judged, measured from each shift's OWN start and
    # grace (attendance_final / arrival_rules.py). Every step follows the one
    # before it, so for a 09:00 shift with 10 min grace and the defaults below:
    #   up to 09:10          on time
    #   09:10 - 10:10        Late (arrival_late_window_minutes): full day, counts in the late pool
    #   10:10 - 11:10        permission window (arrival_permission_window_minutes): an approved, in-cap
    #                        Morning Late-In permission excuses an arrival up to here (and the
    #                        Late window before it); without one the quarter-shift rule applies
    #   11:10 - 11:30        arrival_extra_minutes: still first half, quarter-shift rule
    #   after 11:30          the first half is missed: Absent until a punch at/after
    #                        half_day_second_half_start_time, then Half Day
    # The quarter-shift rule: arrival_quarter_deduction (0.25) is taken off the day, so the employee
    # earns 0.75 rather than losing a whole Half Day - they did come to work. It replaces the Late
    # count for that day (never both). The old fixed half_day_first_half_end_time is retired: the
    # first-half limit is now shift start + grace + these three windows (the column is kept for
    # employees with no shift, old rows and old clients).
    # (db_default on all four: an old backend instance still running during a rolling deploy
    # inserts PayrollSettings rows without knowing these columns exist - see the note above.)
    arrival_late_window_minutes = models.IntegerField(
        default=60, db_default=60, db_column="arrival_late_window_minutes",
        help_text="Staff only. Minutes after the grace period that an arrival is plain Late.",
    )
    arrival_permission_window_minutes = models.IntegerField(
        default=60, db_default=60, db_column="arrival_permission_window_minutes",
        help_text="Staff only. Minutes after the Late window that an approved Morning Late-In permission still excuses.",
    )
    arrival_extra_minutes = models.IntegerField(
        default=20, db_default=20, db_column="arrival_extra_minutes",
        help_text="Staff only. Extra minutes after the permission window that still count as the first half.",
    )
    arrival_quarter_deduction = models.DecimalField(
        max_digits=3, decimal_places=2, default=Decimal("0.25"), db_default=Decimal("0.25"),
        db_column="arrival_quarter_deduction",
        help_text="Staff only. Shift deducted for an arrival after the Late window that no permission covers (0 = none).",
    )

    # ── Late Detection deduction policy (staff payroll) ────────────────────
    # One combined monthly pool: Morning Late-In occurrences, Evening
    # Early-Out occurrences (when enabled), and excess Permissions (approved
    # but beyond permission_monthly_cap) all draw on this same count. The
    # first `late_free_allowance` of that pool are free; everything beyond
    # it is "billable" and priced by the slab table below.
    late_free_allowance = models.IntegerField(
        default=3, db_column="late_free_allowance",
        help_text=(
            "Free lates/early-outs/excess-permissions allowed per employee "
            "per month before any shift deduction applies. All three draw "
            "on this same shared pool."
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

    # ── Afternoon (Night) Late / lunch-return zone (staff, strict mode) ───
    # Strict mode only -simple mode has no punch2/punch3 (lunch) concept.
    # A different axis from Morning Late-In/Evening Early-Out above: this is
    # about a slow return from lunch specifically, anchored to
    # (punch2 + lunch_duration_minutes) rather than a shift edge, since the
    # lunch window is a DURATION, not a time-of-day. Purely informational
    # (late_afternoon flag) -it can no longer demote a day to Half Shift;
    # only the fixed Half-Day rule above decides that now.
    afternoon_late_window_minutes = models.IntegerField(
        default=60, db_column="afternoon_late_window_minutes",
        help_text=(
            "Strict mode only. Minutes past the lunch-return deadline "
            "(punch2 + lunch_duration_minutes) during which a late return "
            "is flagged Night Late. Informational only -see Half-Day "
            "Detection above for what actually decides shift value."
        ),
    )
    afternoon_permission_window_minutes = models.IntegerField(
        default=60, db_column="afternoon_permission_window_minutes",
        help_text=(
            "Strict mode only. Extra minutes past afternoon_late_window_"
            "minutes during which a late lunch return is still just flagged "
            "Night Late (kept for the deadline math; no longer changes "
            "shift value at any point)."
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
    # OT / Compensation background-features master switch. It controls what the feature DOES, never whether
    # the /hr/compensation page exists: the page is mandatory (always in the sidebar, every read endpoint works
    # with the switch off; compensation_views.py's @require_compensation_features_for_changes only refuses the
    # changes nothing would act on). Each background behaviour checks it at its own single choke point:
    # attendance_final.py's _compensation_day_for (Compensation-Day exemption), payroll_views.py's OT-pay block,
    # overtime.py's detect_overtime_for_month (detection). Sub-settings (ot_detection_enabled, ot_threshold_minutes,
    # ot_compensation_type) stay independent finer-grained controls underneath this master switch. Default True
    # since the feature is already live; HR turns it off explicitly (after a confirmation) to pause it.
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

    # ── HR / software-support contacts (Settings -> HR Contact) ───────────
    # One company-wide answer to "who do I call?", shown in the Employee Web App and the mobile app for
    # sign-in problems, app problems and the server being down (support_contact_views.py). Blank = not set.
    hr_contact_name = models.TextField(default="HR Department", db_column="hr_contact_name")
    hr_contact_phone = models.TextField(blank=True, default="", db_column="hr_contact_phone")
    hr_contact_whatsapp = models.TextField(blank=True, default="", db_column="hr_contact_whatsapp")
    hr_contact_email = models.TextField(blank=True, default="", db_column="hr_contact_email")
    hr_contact_hours = models.TextField(blank=True, default="", db_column="hr_contact_hours")
    support_contact_name = models.TextField(default="Software Support", db_column="support_contact_name")
    support_contact_phone = models.TextField(blank=True, default="", db_column="support_contact_phone")
    support_contact_whatsapp = models.TextField(blank=True, default="", db_column="support_contact_whatsapp")
    support_contact_email = models.TextField(blank=True, default="", db_column="support_contact_email")
    support_contact_hours = models.TextField(blank=True, default="", db_column="support_contact_hours")
    # A line of guidance shown under the contacts ("HR office: first floor, admin block").
    contact_note = models.TextField(blank=True, default="", db_column="contact_note")

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
            # (e.g. half_day_first_half_end_time in attendance_final.py).
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
    # Type 1 (the automatic next-day allowance) rows are never decided by HR: they are "auto", listed for information.
    # An assigned Type 2 record is stored as "announced" (the value payroll, the summary and the reports key on).
    STATUS_AUTO = "auto"
    STATUS_CHOICES = [
        (STATUS_DETECTED, "Detected"),
        (STATUS_ANNOUNCED, "Announced"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_AUTO, "Automatic"),
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

    # ── Compensation overhaul (additive; see the master spec) ──────────────────────────────────────────
    # "legacy" = a record made before the overhaul (announced by HR, pay = ONE day, relaxation = one credit);
    # "allowance" = Type 1, the automatic next-day late-in allowance (never paid, never needs HR);
    # "shift" = Type 2, 0.25 / 0.50 / 0.75 / 1 shift that HR assigns by hand.
    OT_TYPE_LEGACY = "legacy"
    OT_TYPE_ALLOWANCE = "allowance"
    OT_TYPE_SHIFT = "shift"
    OT_TYPE_CHOICES = [
        (OT_TYPE_LEGACY, "Legacy"), (OT_TYPE_ALLOWANCE, "Next-day allowance"), (OT_TYPE_SHIFT, "Shift-based"),
    ]
    ot_type = models.CharField(max_length=10, choices=OT_TYPE_CHOICES, default=OT_TYPE_LEGACY, db_default=OT_TYPE_LEGACY, db_column="ot_type")
    # Type 1: the minutes the rule table granted for the next morning.
    allowance_minutes = models.IntegerField(default=0, db_default=0, db_column="allowance_minutes")
    # Type 2: what the rule table SUGGESTS for this day, and what HR assigned (null until assigned; a legacy
    # announced `pay` record has null here and counts as 1.00 shift in payroll, exactly what it always paid).
    suggested_shifts = models.DecimalField(max_digits=3, decimal_places=2, null=True, blank=True, db_column="suggested_shifts")
    shifts = models.DecimalField(max_digits=3, decimal_places=2, null=True, blank=True, db_column="shifts")
    # Type 2: the date the compensation is granted for (same month as `date`): the day off for relaxation.
    claim_date = models.DateField(null=True, blank=True, db_column="claim_date")

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

    # Compensation overhaul: what the announcement does. "day" = the legacy kind (the day is exempt from Late /
    # Permission detection, optional `leave_until_time`); "late_in" = for this date staff may arrive up to
    # `allowed_time` (their own start and grace do not apply); "early_out" = for this date staff may leave from
    # `leave_until_time` on (their own end and grace do not apply).
    KIND_DAY = "day"
    KIND_LATE_IN = "late_in"
    KIND_EARLY_OUT = "early_out"
    KIND_CHOICES = [(KIND_DAY, "Day exemption"), (KIND_LATE_IN, "Late-in"), (KIND_EARLY_OUT, "Early-out")]
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default=KIND_DAY, db_default=KIND_DAY, db_column="kind")
    allowed_time = models.TimeField(null=True, blank=True, db_column="allowed_time")

    class Meta:
        db_table = "compensation_day_announcements"
        ordering = ["-date"]


class CompensationConfig(models.Model):
    """The Compensation tab of Settings: one row (pk=1) of switches and thresholds. Every feature has its own
    switch; PayrollSettings.compensation_feature_enabled stays the master switch above all of them. The
    `*_effective_from` dates keep a feature from reaching back into months that are already paid: the attendance
    engine applies it only to dates on or after it (set the day a feature is first switched on)."""

    # Type 1: automatic next-day late-in allowance (rules: CompensationRule kind=allowance)
    allowance_enabled = models.BooleanField(default=False, db_column="allowance_enabled")
    allowance_effective_from = models.DateField(null=True, blank=True, db_column="allowance_effective_from")
    # Type 2: shift-based compensation HR assigns (rules: CompensationRule kind=shift)
    shift_enabled = models.BooleanField(default=False, db_column="shift_enabled")
    # extra minutes past the shift end where Type 2 starts (Type 1 covers everything up to it)
    shift_min_extra_minutes = models.IntegerField(default=150, db_column="shift_min_extra_minutes")
    relaxation_enabled = models.BooleanField(default=True, db_column="relaxation_enabled")
    pay_enabled = models.BooleanField(default=False, db_column="pay_enabled")
    # Compensation Leave A: company-announced late-in / early-out windows
    windows_enabled = models.BooleanField(default=False, db_column="windows_enabled")
    # Compensation Leave B: work on Sundays / company holidays (HOD-approved, goes to the balance)
    holiday_work_enabled = models.BooleanField(default=False, db_column="holiday_work_enabled")
    # Compensation Leave C: paid birthday leave
    birthday_enabled = models.BooleanField(default=False, db_column="birthday_enabled")
    birthday_effective_from = models.DateField(null=True, blank=True, db_column="birthday_effective_from")
    updated_by = models.TextField(null=True, blank=True, db_column="updated_by")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "compensation_config"

    @classmethod
    def get(cls) -> "CompensationConfig":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class CompensationRule(models.Model):
    """One editable row of a Settings rule table (HR can edit, disable and ADD rows).

    kind=allowance (Type 1): `min_extra_minutes` of work past the shift end earns `allowance_minutes` for the
      next morning's first punch. The row with the biggest min_extra_minutes the day reaches wins.
    kind=shift (Type 2): a ladder on the clock time of the day's LAST punch-out, in minutes since the OT day's
      midnight (a punch after midnight is 1440 + its clock minutes). The first enabled row, in `until_minutes`
      order, whose `until_minutes` is greater than the last punch gives `shifts`; `until_minutes` null = no upper
      limit (the last row). Only days past CompensationConfig.shift_min_extra_minutes are looked up."""

    KIND_ALLOWANCE = "allowance"
    KIND_SHIFT = "shift"
    KIND_CHOICES = [(KIND_ALLOWANCE, "Next-day allowance"), (KIND_SHIFT, "Shift-based")]
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, db_column="kind")
    label = models.TextField(default="", blank=True)
    enabled = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0, db_column="sort_order")
    min_extra_minutes = models.IntegerField(null=True, blank=True, db_column="min_extra_minutes")
    allowance_minutes = models.IntegerField(null=True, blank=True, db_column="allowance_minutes")
    until_minutes = models.IntegerField(null=True, blank=True, db_column="until_minutes")
    shifts = models.DecimalField(max_digits=3, decimal_places=2, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "compensation_rules"
        ordering = ["kind", "sort_order", "id"]


class HolidayWorkClaim(models.Model):
    """Compensation for working on a Sunday or a company holiday: HR assigns 0.25 / 0.50 / 0.75 / 1 shift and the
    Department Head must approve it (approval_workflow key `holiday_work`, HR-requested like an attendance
    correction). Approval adds the shifts to the employee's compensation balance (CompensationLedger) exactly once."""

    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_APPROVED, "Approved"), (STATUS_REJECTED, "Rejected")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="holiday_work_claims",
    )
    work_date = models.DateField(db_column="work_date")
    shifts = models.DecimalField(max_digits=3, decimal_places=2)
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    requested_by = models.TextField(null=True, blank=True, db_column="requested_by")
    reviewed_by = models.TextField(null=True, blank=True, db_column="reviewed_by")
    review_comment = models.TextField(null=True, blank=True, db_column="review_comment")
    reviewed_at = models.DateTimeField(null=True, blank=True, db_column="reviewed_at")
    # The approval pipeline's progress (approval_workflow.py): [{role, decision, by, at, comment, skipped}].
    approval_trail = models.JSONField(null=True, blank=True, db_column="approval_trail")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "holiday_work_claims"
        ordering = ["-created_at"]
        constraints = [
            # One pending-or-approved claim per employee per work date (a rejected one can be raised again): the
            # database refuses what the row locks in holiday_work_views are meant to prevent, whoever writes.
            models.UniqueConstraint(
                fields=["employee", "work_date"],
                condition=models.Q(status__in=["pending", "approved"]),
                name="uniq_open_holiday_work_claim",
            ),
        ]


class CompensationLedger(models.Model):
    """The compensation balance of an employee, in shifts: entries are only ever added, never edited. A credit comes
    from an approved HolidayWorkClaim (or a migrated legacy credit); a debit is HR redeeming shifts on a date.
    balance = sum(credits) - sum(debits)."""

    ENTRY_CREDIT = "credit"
    ENTRY_DEBIT = "debit"
    ENTRY_CHOICES = [(ENTRY_CREDIT, "Credit"), (ENTRY_DEBIT, "Debit")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="compensation_ledger",
    )
    entry_type = models.CharField(max_length=6, choices=ENTRY_CHOICES, db_column="entry_type")
    shifts = models.DecimalField(max_digits=3, decimal_places=2)  # always positive
    # credit: the day it was earned (the work date); debit: the day it was taken
    date = models.DateField()
    source = models.CharField(max_length=24, default="")  # holiday_work | legacy_credit | redemption | ot_shift
    claim = models.ForeignKey(
        HolidayWorkClaim, on_delete=models.SET_NULL, null=True, blank=True, db_column="claim_id", related_name="ledger_entries",
    )
    overtime_record = models.ForeignKey(
        OvertimeRecord, on_delete=models.SET_NULL, null=True, blank=True, db_column="overtime_record_id", related_name="ledger_entries",
    )
    note = models.TextField(null=True, blank=True)
    created_by = models.TextField(null=True, blank=True, db_column="created_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "compensation_ledger"
        ordering = ["-created_at"]
        constraints = [
            # An approved claim is credited exactly once, and an OT record announced to the balance exactly once.
            models.UniqueConstraint(
                fields=["claim"],
                condition=models.Q(entry_type="credit", claim__isnull=False),
                name="uniq_ledger_credit_per_claim",
            ),
            models.UniqueConstraint(
                fields=["overtime_record"],
                condition=models.Q(source="ot_shift", overtime_record__isnull=False),
                name="uniq_ledger_ot_credit_per_record",
            ),
        ]


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

    # -- Production shift rules (2026-10-14) ---------------------------------
    # The punch1..4 times, grace_minutes (10) and ProductionShiftSegment above are the LEGACY calculation. They are
    # never changed: every day BEFORE rules_effective_from keeps being judged by them (nothing already paid is
    # re-judged), and the legacy endpoints stay. Days on/after rules_effective_from are judged by the groups / ladder
    # rules / breaks below (production_shift_rules.py). Every column has a database default so a release that is still
    # running during a rolling deploy can keep inserting rows.
    rules_enabled = models.BooleanField(default=True, db_default=True, db_column="rules_enabled")
    # The first day the new rules judge. Set to the day the migration ran (IST), or the day a fresh row was created.
    # NULL (a row nobody scheduled) means "not in force": the legacy calculation.
    rules_effective_from = models.DateField(null=True, blank=True, db_column="rules_effective_from")
    rules_grace_minutes = models.IntegerField(default=5, db_default=5, db_column="rules_grace_minutes")
    # Minimum shifts credited to a worker with at least one complete in/out pair (0 = none).
    rules_min_credit = models.DecimalField(
        max_digits=4, decimal_places=2, default=Decimal("0.00"), db_default=Decimal("0.00"), db_column="rules_min_credit",
    )
    # A day's total is rounded to a multiple of this step (0.01, 0.05 or 0.25), 'nearest' or 'down'.
    rules_rounding_step = models.DecimalField(
        max_digits=4, decimal_places=2, default=Decimal("0.01"), db_default=Decimal("0.01"), db_column="rules_rounding_step",
    )
    rules_rounding_mode = models.TextField(default="nearest", db_default="nearest", db_column="rules_rounding_mode")
    # A day below this is a Half Shift (status half_shift), at or above it Present.
    rules_full_day_value = models.DecimalField(
        max_digits=4, decimal_places=2, default=Decimal("1.00"), db_default=Decimal("1.00"), db_column="rules_full_day_value",
    )
    # Most hours between an open "in" punch and the next calendar day's first punch for that punch to close the session
    # (default 18: 13:30 open + a 03:00 close is 13.5 h). The punch must ALSO be at or before the derived close-by time
    # (latest next-day out time of the rules + 90 minutes), see production_shift_rules.RuleSet.close_by_s.
    rules_night_session_hours = models.IntegerField(default=18, db_default=18, db_column="rules_night_session_hours")

    class Meta:
        db_table = "production_shift_config"

    def save(self, *args, **kwargs):
        # A row created any other way than the migration (ProductionShiftConfig.get(), objects.create, get_or_create)
        # starts its rules today, never in the past: a past effective date would re-judge days already paid.
        if self._state.adding and self.rules_effective_from is None:
            self.rules_effective_from = ist_today()
        super().save(*args, **kwargs)

    @classmethod
    def get(cls) -> "ProductionShiftConfig":
        obj, _ = cls.objects.get_or_create(pk=1, defaults={"rules_effective_from": ist_today()})
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


class ProductionShiftGroup(models.Model):
    """
    One kind of production day (Day, Night, Sunday, or one HR adds): where it starts, which first punches it takes, and
    its ladder of ProductionShiftRule points. See production_shift_rules.py for how a day is picked and calculated.
    """
    KIND_CHOICES = [("day", "Day"), ("night", "Night"), ("sunday", "Sunday"), ("custom", "Custom")]
    APPLIES_ON_CHOICES = [("mon_sat", "Monday to Saturday"), ("sunday", "Sunday"), ("all", "Every day")]

    label = models.TextField()
    kind = models.TextField(choices=KIND_CHOICES, default="custom")
    applies_on = models.TextField(choices=APPLIES_ON_CHOICES, default="mon_sat", db_column="applies_on")
    # The reference in-time of the shift (08:30 for the day shift, 21:00 for the night shift).
    start_time = models.TimeField(db_column="start_time")
    # A day whose first punch (its clock time) falls in [first_punch_from, first_punch_to] uses this group.
    first_punch_from = models.TimeField(db_column="first_punch_from")
    first_punch_to = models.TimeField(db_column="first_punch_to")
    # The standard departure: used only for the early-leave flag (a night shift's 05:30 is the next day).
    main_out_time = models.TimeField(null=True, blank=True, db_column="main_out_time")
    main_out_next_day = models.BooleanField(default=False, db_column="main_out_next_day")
    enabled = models.BooleanField(default=True)
    order = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "production_shift_groups"
        ordering = ["order", "id"]


class ProductionShiftRule(models.Model):
    """
    One ladder point of a group: "a worker who leaves at out_time (the next day when out_next_day) earned shift_value".
    Between two points the value grows in proportion to PAID time (breaks excluded), so each band has its own rate.
    One out time may appear once per group among the enabled rows (checked by the API).
    """
    group = models.ForeignKey(
        ProductionShiftGroup, on_delete=models.CASCADE, db_column="group_id", related_name="rules",
    )
    label = models.TextField(blank=True, default="")
    out_time = models.TimeField(db_column="out_time")
    out_next_day = models.BooleanField(default=False, db_column="out_next_day")
    shift_value = models.DecimalField(max_digits=4, decimal_places=2, db_column="shift_value")
    enabled = models.BooleanField(default=True)
    order = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "production_shift_rules"
        ordering = ["order", "id"]


class ProductionBreak(models.Model):
    """
    An UNPAID break window (tea, lunch, dinner): same-day, start < end, the same for every group every day. Nobody has
    to punch for it; the calculation simply never pays the minutes inside it.
    """
    label = models.TextField(blank=True, default="")
    start_time = models.TimeField(db_column="start_time")
    end_time = models.TimeField(db_column="end_time")
    enabled = models.BooleanField(default=True)
    order = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "production_breaks"
        ordering = ["order", "id"]
