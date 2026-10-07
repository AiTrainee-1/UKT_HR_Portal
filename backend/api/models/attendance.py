"""Punches, daily attendance verdicts, on-duty / geo attendance, biometric devices."""

from django.db import models

from .core import Branch, Employee
from .leave import ShiftTemplate


# ──────────────────────────────────────────────
#  Attendance
# ──────────────────────────────────────────────

class Attendance(models.Model):
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="attendance_records"
    )
    date = models.TextField()
    present = models.BooleanField(default=True)
    hours_worked = models.DecimalField(
        max_digits=4, decimal_places=2, null=True, blank=True, db_column="hours_worked"
    )
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance"
        unique_together = [("employee", "date")]


class AttendanceLog(models.Model):
    PUNCH_IN = "IN"
    PUNCH_OUT = "OUT"
    PUNCH_CHOICES = [(PUNCH_IN, "In"), (PUNCH_OUT, "Out")]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="attendance_logs",
    )
    date = models.DateField()
    punch_time = models.TimeField(db_column="punch_time")
    punch_type = models.TextField(choices=PUNCH_CHOICES, db_column="punch_type")
    source = models.TextField(default="manual")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance_logs"
        ordering = ["date", "punch_time"]
        unique_together = [("employee", "date", "punch_time", "punch_type")]


class DailyShiftLog(models.Model):
    """Computed 4-punch result per staff employee per day."""
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="daily_shift_logs"
    )
    date = models.DateField()
    shift = models.ForeignKey(
        ShiftTemplate, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="shift_id", related_name="daily_logs"
    )
    punch1 = models.TimeField(null=True, blank=True)   # morning IN
    punch2 = models.TimeField(null=True, blank=True)   # lunch OUT
    punch3 = models.TimeField(null=True, blank=True)   # lunch IN (return)
    punch4 = models.TimeField(null=True, blank=True)   # evening OUT
    total_punches = models.IntegerField(default=0)
    first_half = models.BooleanField(default=False)
    second_half = models.BooleanField(default=False)
    shifts_completed = models.DecimalField(max_digits=3, decimal_places=2, default=0)
    late_morning = models.BooleanField(default=False)
    late_return = models.BooleanField(default=False)
    late_reason = models.TextField(null=True, blank=True)
    computed_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "daily_shift_logs"
        unique_together = [["employee", "date"]]


class MonthlyShiftSummary(models.Model):
    """Aggregated late + shift summary per employee per month, used by payroll."""
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="monthly_shift_summaries"
    )
    year = models.IntegerField()
    month = models.IntegerField()
    total_shifts = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    total_late_count = models.IntegerField(default=0)       # late punches only
    # Approved EmployeePermission requests beyond the first 3 in the month —
    # merged into the same late pool as total_late_count for the deduction
    # formula below, but kept separate here so HR can see why a deduction
    # happened (late arrivals vs. excess permission requests).
    permission_overage_count = models.IntegerField(default=0)
    permissions_used = models.IntegerField(default=0)       # of 3 free
    billable_late_count = models.IntegerField(default=0)    # after 3 free, combined pool
    shift_deductions = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    salary_deduction_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "monthly_shift_summaries"
        unique_together = [["employee", "year", "month"]]


# ──────────────────────────────────────────────
#  Final Attendance (auto-computed + HR override)
# ──────────────────────────────────────────────

class AttendanceDayRecord(models.Model):
    """
    The FINAL per-day attendance verdict for one employee.

    Auto-computed from punches (using the mode selected in settings), then
    optionally overridden by HR. When source == "manual" the values here are
    authoritative -payroll and salary always read from this table first.
    """
    STATUS_PRESENT = "present"
    STATUS_ABSENT = "absent"
    STATUS_HALF = "half_shift"
    STATUS_LEAVE = "on_leave"
    STATUS_HOLIDAY = "holiday"
    STATUS_CHOICES = [
        (STATUS_PRESENT, "Present"),
        (STATUS_ABSENT, "Absent"),
        (STATUS_HALF, "Half Shift"),
        (STATUS_LEAVE, "On Leave"),
        (STATUS_HOLIDAY, "Holiday"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="attendance_day_records",
    )
    date = models.DateField()
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_ABSENT)
    # Morning Late-In: punch after (shift start + grace), or after the
    # permission-shifted effective start when an in-cap Morning Late-In
    # permission applies today (see morning_permission_applied below and
    # attendance_final.py). Completely independent of is_half_shift/status
    # -a very late arrival that still beats the Half-Day cutoff is Full Day
    # AND Late, not automatically demoted.
    is_late = models.BooleanField(default=False, db_column="is_late")
    is_half_shift = models.BooleanField(default=False, db_column="is_half_shift")
    # Evening Early-Out: punch before (shift end - grace), or before the
    # permission-shifted effective end when an in-cap Evening Early-Out
    # permission applies today. Only ever set when PayrollSettings.
    # evening_early_out_enabled is on (off by default) -see attendance_final.py.
    early_leave = models.BooleanField(default=False, db_column="early_leave")
    # An approved Morning Late-In / Evening Early-Out permission existed
    # today but was EXCESS (this employee had already used
    # PayrollSettings.permission_monthly_cap approved permissions earlier
    # that month), so it did NOT shift the boundary -the day was judged
    # against the plain shift time like an ordinary unexcused occurrence,
    # and any resulting is_late/early_leave joins the same late-deduction
    # pool as an unexcused late. Lets HR/an employee see exactly why a
    # request that WAS approved still didn't protect that day.
    # (db_default on the five permission columns: an old backend instance that
    # is still running during a rolling deploy inserts day records without
    # knowing these columns exist -see the matching note on PayrollSettings.)
    morning_permission_excess = models.BooleanField(default=False, db_default=False, db_column="morning_permission_excess")
    evening_permission_excess = models.BooleanField(default=False, db_default=False, db_column="evening_permission_excess")
    # Night Late: strict-mode lunch-return lateness (punch3 beyond punch2 +
    # lunch_duration_minutes, within the afternoon Late window -see
    # PayrollSettings.afternoon_late_window_minutes). Informational only -
    # can no longer demote the day; unrelated to Morning Late-In/Evening
    # Early-Out above (a different axis the Late Detection rewrite left
    # untouched).
    late_afternoon = models.BooleanField(default=False, db_column="late_afternoon")
    # True when an approved, IN-CAP Morning Late-In / Evening Early-Out
    # permission actually shifted today's effective boundary (see
    # attendance_final.py's permission boundary-shift). False whenever no
    # permission applied, including when one was approved but excess (see
    # morning/evening_permission_excess above).
    morning_permission_applied = models.BooleanField(default=False, db_default=False, db_column="morning_permission_applied")
    evening_permission_applied = models.BooleanField(default=False, db_default=False, db_column="evening_permission_applied")
    # An approved Middle One-Hour permission exists today -purely
    # informational (it never shifts any boundary, in or out of the
    # monthly cap), but still worth showing so HR/the employee can see it
    # was accounted for.
    middle_permission_today = models.BooleanField(default=False, db_default=False, db_column="middle_permission_today")
    # Unchanged -the strict-mode lunch-return axis's own auto-detected
    # Permission zone (see PayrollSettings.afternoon_permission_window_
    # minutes), untouched by the Late Detection/Permission rewrite.
    permission_afternoon = models.BooleanField(default=False, db_column="permission_afternoon")
    permission_afternoon_with_request = models.BooleanField(default=False, db_column="permission_afternoon_with_request")
    # True when a CompensationDayAnnouncement covered this day -Late/Permission
    # detection was suppressed (see attendance_final.py's compensation-day
    # exemption). Display/audit only: Full vs Half is still decided from real
    # punches (against leave_until_time as the effective shift end, when set)
    # -this flag never changes shifts_earned by itself.
    is_compensation_day = models.BooleanField(default=False, db_column="is_compensation_day")
    # HR-set report annotation for the Report Log page's Daily Report (on-leave
    # employees: did they inform in advance?) -null/blank = never set, True =
    # Informed, False = Not Informed. Set only via PATCH /api/attendance/
    # day-informed (attendance_views.py::set_day_informed), never by any
    # compute_day_record recompute -update_or_create's defaults=fields only
    # touches keys present in that dict, and this one deliberately isn't, so
    # a later recompute of this day never clobbers HR's manual note here.
    is_informed = models.BooleanField(null=True, blank=True, default=None, db_column="is_informed")
    # Where the first punch fell on the morning arrival timeline (attendance_final /
    # arrival_rules.py): "on_time" | "late" | "excused" (an approved Morning Late-In permission
    # covered it) | "quarter" (after the Late window: 0.25 shift deducted) | "second_half" (after
    # the first-half limit: the morning half was missed). Blank for manual rows, employees with no
    # shift, production and rows computed before this existed. It says which half a Half Day was
    # worked and why a day earned 0.75 - shifts_earned, not this, is what payroll reads.
    arrival_zone = models.CharField(max_length=12, default="", blank=True, db_default="", db_column="arrival_zone")
    # Display-only explanation of why is_late/is_half_shift ended up True this
    # day (e.g. "Late morning (Without Permission): arrived 09:40, deadline
    # 09:15"). Never read by any calculation — purely so Payroll/Attendance
    # UI can show HR *why* a detection fired instead of just that it fired.
    # Null whenever nothing was flagged.
    late_reason = models.TextField(null=True, blank=True, db_column="late_reason")
    # Set when an approved Half-Day Leave (LeaveRequest.is_half_day) accounts
    # for this day -see attendance_final.py::_half_day_leave_for. Distinct
    # from is_half_shift, which is purely punch-derived (a single punch, or a
    # late arrival) and carries its own punctuality/relaxation machinery that
    # a leave-derived half day must never be pulled into.
    is_half_day_leave = models.BooleanField(default=False, db_column="is_half_day_leave")
    shifts_earned = models.DecimalField(
        max_digits=3, decimal_places=2, default=0, db_column="shifts_earned",
        help_text="0.50 per half. Staff max 1.00, production max 1.50."
    )
    first_punch = models.TimeField(null=True, blank=True, db_column="first_punch")
    last_punch = models.TimeField(null=True, blank=True, db_column="last_punch")
    total_punches = models.IntegerField(default=0, db_column="total_punches")
    computed_mode = models.TextField(null=True, blank=True, db_column="computed_mode")  # strict/simple
    source = models.TextField(default="auto")  # auto | manual
    primary_source = models.TextField(
        null=True, blank=True, db_column="primary_source",
        help_text=(
            "Which punch source this day's attendance actually came from -"
            "'Biometric' / 'On-Duty' / 'Geo Punch' / 'HR Entry', or null if "
            "no punches. Biometric always wins whenever it contributed "
            "anything that day, regardless of what else is present. Purely "
            "a display field -never used in shift-value calculations."
        ),
    )
    override_by = models.TextField(null=True, blank=True, db_column="override_by")
    override_note = models.TextField(null=True, blank=True, db_column="override_note")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "attendance_day_records"
        unique_together = [["employee", "date"]]
        ordering = ["date"]


# ──────────────────────────────────────────────
#  Attendance Override Requests (two-level approval)
# ──────────────────────────────────────────────

class AttendanceOverrideRequest(models.Model):
    """
    HR proposes a manual attendance change; a Department Head must approve it
    before the AttendanceDayRecord is actually overwritten. Prevents HR from
    silently editing attendance without accountability.
    """
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="attendance_override_requests",
    )
    date = models.DateField()
    # Snapshot of the record before the change, and the change requested -both JSON
    previous_values = models.JSONField(default=dict, db_column="previous_values")
    requested_values = models.JSONField(default=dict, db_column="requested_values")
    reason = models.TextField(null=True, blank=True)
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    requested_by = models.TextField(null=True, blank=True, db_column="requested_by")
    reviewed_by = models.TextField(null=True, blank=True, db_column="reviewed_by")
    review_comment = models.TextField(null=True, blank=True, db_column="review_comment")
    reviewed_at = models.DateTimeField(null=True, blank=True, db_column="reviewed_at")
    # Who has approved this request so far under the approval pipeline (approval_workflow.py): a list of
    # {"role": "hod"|"hr", "decision", "by", "at", "comment", "skipped"}. Null on requests made before it existed;
    # approval_workflow.trail_of() derives it from the older per-role stamps then.
    approval_trail = models.JSONField(null=True, blank=True, db_column="approval_trail")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "attendance_override_requests"
        ordering = ["-created_at"]


# ──────────────────────────────────────────────
#  Geo Attendance (location-based punching)
# ──────────────────────────────────────────────

class OnDutySession(models.Model):
    """
    An employee working away from the branch for a day (field visit, driver,
    offsite work) declares an On-Duty session: just a destination and a
    reason to go, no photos or GPS at request time -that verification now
    happens per-punch (see OnDutyPunchVerification below), not at the gate.
    Same two-stage approval chain as before:
      1. pending_hod -> the employee's Department Head approves/rejects
         (mobile Approvals screen, manager_views.py::manager_update_on_duty_status)
      2. pending_hr  -> HR gives the final approval (HR portal dashboard)
    A HOD rejection short-circuits straight to "rejected" -HR is never
    consulted. HR may also act directly on a still-pending_hod session as a
    fallback (e.g. no Department Head assigned), finalizing to
    active/rejected in one step.

    IMPORTANT -the employee does NOT wait for either stage. From the moment
    the request is submitted the session is "provisionally active": the app
    presents it as approved and the employee may punch and be tracked
    immediately (see _punchable_on_duty_session). Only the HRMS-side truth
    stays pending. Nothing a provisional session captures can reach
    AttendanceLog -OnDutyPunchVerification rows are held, and HR is blocked
    from approving any of them, until this session itself reaches "active".
    A rejection at either stage voids every punch the session captured, so a
    rejected day can never leave real attendance behind.

    Once HR approves, status becomes "active" and started_at is stamped —
    this is what gates live-location tracking (geo_attendance_views.py::
    live_location_ping) and routes the employee's regular attendance punches
    through the photo+GPS verification flow instead of a plain punch. The
    session ends in "completed", either automatically (their 4th punch of
    the day gets HR-approved -see OnDutyPunchVerification) or manually (the
    employee taps "Done" in the mobile app -nobody else can end it early).
    """
    STATUS_PENDING_HOD = "pending_hod"
    STATUS_PENDING_HR = "pending_hr"
    STATUS_ACTIVE = "active"
    STATUS_COMPLETED = "completed"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING_HOD, "Pending HOD Approval"),
        (STATUS_PENDING_HR, "Pending HR Approval"),
        (STATUS_ACTIVE, "Active"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_REJECTED, "Rejected"),
    ]

    COMPLETION_MANUAL = "manual"
    COMPLETION_AUTO_4TH_PUNCH = "auto_4th_punch"
    COMPLETION_AUTO_DAY_END = "auto_day_end"
    COMPLETION_CHOICES = [
        (COMPLETION_MANUAL, "Manual -Employee Marked Done"),
        (COMPLETION_AUTO_4TH_PUNCH, "Automatic -All 4 Punches Recorded"),
        (COMPLETION_AUTO_DAY_END, "Automatic -Day Ended (11 PM)"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="on_duty_sessions",
    )
    destination = models.TextField()
    # Snapshot of the branch the employee was assigned to at request time,
    # kept even if they're later moved to a different branch. Purely
    # informational context for the approver -On-Duty has no geofence
    # check of its own (that's the whole point -they're meant to be offsite).
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True, db_column="branch_id",
    )
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING_HOD)
    hod_reviewed_by = models.TextField(null=True, blank=True, db_column="hod_reviewed_by")
    hod_review_comment = models.TextField(null=True, blank=True, db_column="hod_review_comment")
    hod_reviewed_at = models.DateTimeField(null=True, blank=True, db_column="hod_reviewed_at")
    # Who has approved this request so far under the approval pipeline (approval_workflow.py): a list of
    # {"role": "hod"|"hr", "decision", "by", "at", "comment", "skipped"}. Null on requests made before it existed;
    # approval_workflow.trail_of() derives it from the older per-role stamps then.
    approval_trail = models.JSONField(null=True, blank=True, db_column="approval_trail")
    hr_reviewed_by = models.TextField(null=True, blank=True, db_column="hr_reviewed_by")
    hr_review_comment = models.TextField(null=True, blank=True, db_column="hr_review_comment")
    hr_reviewed_at = models.DateTimeField(null=True, blank=True, db_column="hr_reviewed_at")
    started_at = models.DateTimeField(null=True, blank=True, db_column="started_at")
    # When the employee tapped "Done" in the app. Separate from completed_at
    # because an employee may start AND finish a whole day of provisional
    # on-duty work before HR ever looks at the request -recording that on
    # `status` would drop the session out of HR's pending queue and strand
    # its captured punches forever. So the employee's own end-of-day marker
    # lives here, and `status` stays pending until HR actually decides.
    employee_ended_at = models.DateTimeField(null=True, blank=True, db_column="employee_ended_at")
    completed_at = models.DateTimeField(null=True, blank=True, db_column="completed_at")
    completed_by = models.TextField(null=True, blank=True, db_column="completed_by")
    completion_reason = models.TextField(choices=COMPLETION_CHOICES, null=True, blank=True, db_column="completion_reason")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "on_duty_sessions"
        ordering = ["-created_at"]


class OnDutyPunchVerification(models.Model):
    """
    One of the employee's 4 daily attendance punches, made while an
    OnDutySession is active -reuses the SAME shared 4-punch-per-day slot
    system every other punch source uses (biometric, Office Geo Punch), it
    does not add a separate on-duty punch count. The difference is that an
    on-duty punch is never written straight to AttendanceLog: it's captured
    with a selfie + GPS + the original time, held as "pending", and only
    becomes a real punch (via biometric_sync._ingest_punches(), tagged
    "on_duty:approved", at the ORIGINAL captured punch_time) once HR
    approves it -this is the fraud check the office/biometric paths don't
    need, since this employee is off-site and unsupervised. Only one
    verification may be pending at a time per employee (see
    geo_attendance_views.py::on_duty_punch_request) -a rejected one simply
    leaves that punch slot open for a fresh submission.

    When the punch this verification resolves to is the day's 4th, approving
    it also auto-completes the parent OnDutySession
    (completion_reason=auto_4th_punch) -see resolve_on_duty_punch_hr().
    """
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending HR Approval"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    session = models.ForeignKey(
        OnDutySession, on_delete=models.CASCADE, db_column="session_id",
        related_name="punch_verifications",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="on_duty_punch_verifications",
    )
    punch_date = models.DateField(db_column="punch_date")
    punch_time = models.TimeField(db_column="punch_time")
    punch_type = models.TextField(choices=AttendanceLog.PUNCH_CHOICES, db_column="punch_type")
    punch_number = models.IntegerField(db_column="punch_number")
    latitude = models.DecimalField(max_digits=9, decimal_places=6, db_column="latitude")
    longitude = models.DecimalField(max_digits=9, decimal_places=6, db_column="longitude")
    accuracy_m = models.FloatField(null=True, blank=True, db_column="accuracy_m")
    is_mocked = models.BooleanField(default=False, db_column="is_mocked")
    photo = models.FileField(upload_to="on_duty_punch_verifications/%Y/%m/", db_column="photo")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING)
    hr_reviewed_by = models.TextField(null=True, blank=True, db_column="hr_reviewed_by")
    hr_review_comment = models.TextField(null=True, blank=True, db_column="hr_review_comment")
    hr_reviewed_at = models.DateTimeField(null=True, blank=True, db_column="hr_reviewed_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "on_duty_punch_verifications"
        ordering = ["-created_at"]


class MissingPunchRequest(models.Model):
    """
    Employee self-service "I forgot to punch" request -date + time + reason,
    approved by the Department Head first, then HR gives the final approval.
    Same two-stage status machine as OnDutySession above (the only other
    genuine HOD-then-HR workflow in this codebase): a HOD rejection is
    terminal (HR never sees it); HR only ever acts on a row already at
    pending_hr.

    On HR approval, this does NOT overwrite the day's AttendanceDayRecord
    directly (unlike CasualLeaveRequest/AttendanceOverrideRequest, which
    decide an entire day's outcome) -it creates one ordinary AttendanceLog
    row (source="missing_punch:approved") via resolve_missing_punch_hr() in
    missing_punch_views.py, so it becomes just another punch that day and
    flows through the normal engine (punch-order combination rule,
    punctuality window, cross-midnight reattribution) exactly like a real
    biometric punch would. Idempotent against double-approval because
    AttendanceLog already has unique_together on
    (employee, date, punch_time, punch_type).
    """
    STATUS_PENDING_HOD = "pending_hod"
    STATUS_PENDING_HR = "pending_hr"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING_HOD, "Pending HOD Approval"),
        (STATUS_PENDING_HR, "Pending HR Approval"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    # Which of the day's (up to) 4 punches this request represents -purely
    # descriptive, shown to the employee/HOD/HR so it's clear which specific
    # punch is missing. Deliberately NOT the source of truth for P1-P4
    # identity: that's derived by shift_engine.compute_daily_shift_log from
    # each punch's actual TIME relative to the shift's lunch window, computed
    # fresh every time attendance is calculated -never stored anywhere. This
    # field only maps onto punch_type (morning_in/lunch_in -> IN,
    # lunch_out/evening_out -> OUT), which is what actually gets written to
    # AttendanceLog on HR approval.
    PUNCH_SLOT_MORNING_IN = "morning_in"
    PUNCH_SLOT_LUNCH_OUT = "lunch_out"
    PUNCH_SLOT_LUNCH_IN = "lunch_in"
    PUNCH_SLOT_EVENING_OUT = "evening_out"
    PUNCH_SLOT_CHOICES = [
        (PUNCH_SLOT_MORNING_IN, "Morning Check-In"),
        (PUNCH_SLOT_LUNCH_OUT, "Lunch Check-Out"),
        (PUNCH_SLOT_LUNCH_IN, "Lunch Check-In"),
        (PUNCH_SLOT_EVENING_OUT, "Evening Check-Out"),
    ]
    PUNCH_SLOT_TO_TYPE = {
        PUNCH_SLOT_MORNING_IN: AttendanceLog.PUNCH_IN,
        PUNCH_SLOT_LUNCH_OUT: AttendanceLog.PUNCH_OUT,
        PUNCH_SLOT_LUNCH_IN: AttendanceLog.PUNCH_IN,
        PUNCH_SLOT_EVENING_OUT: AttendanceLog.PUNCH_OUT,
    }

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="missing_punch_requests",
    )
    date = models.DateField()
    punch_time = models.TimeField(db_column="punch_time")
    punch_type = models.TextField(choices=AttendanceLog.PUNCH_CHOICES, db_column="punch_type")
    punch_slot = models.TextField(
        choices=PUNCH_SLOT_CHOICES, null=True, blank=True, db_column="punch_slot",
    )
    reason = models.TextField()
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING_HOD)
    hod_reviewed_by = models.TextField(null=True, blank=True, db_column="hod_reviewed_by")
    hod_review_comment = models.TextField(null=True, blank=True, db_column="hod_review_comment")
    hod_reviewed_at = models.DateTimeField(null=True, blank=True, db_column="hod_reviewed_at")
    # Who has approved this request so far under the approval pipeline (approval_workflow.py): a list of
    # {"role": "hod"|"hr", "decision", "by", "at", "comment", "skipped"}. Null on requests made before it existed;
    # approval_workflow.trail_of() derives it from the older per-role stamps then.
    approval_trail = models.JSONField(null=True, blank=True, db_column="approval_trail")
    hr_reviewed_by = models.TextField(null=True, blank=True, db_column="hr_reviewed_by")
    hr_review_comment = models.TextField(null=True, blank=True, db_column="hr_review_comment")
    hr_reviewed_at = models.DateTimeField(null=True, blank=True, db_column="hr_reviewed_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "missing_punch_requests"
        ordering = ["-created_at"]


class LiveLocationPing(models.Model):
    """
    One GPS sample from an employee with location_tracking_enabled=True.
    Append-only (not upsert) so the HR map can draw today's breadcrumb trail,
    not just a single current dot -see geo_attendance_views.py::live_location_ping,
    which also prunes each employee's pings older than 24h on every write so
    this table never grows unbounded (no cron/Celery in this project).
    """
    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="location_pings",
    )
    latitude = models.DecimalField(max_digits=9, decimal_places=6, db_column="latitude")
    longitude = models.DecimalField(max_digits=9, decimal_places=6, db_column="longitude")
    accuracy_m = models.FloatField(null=True, blank=True, db_column="accuracy_m")
    is_mocked = models.BooleanField(default=False, db_column="is_mocked")
    recorded_at = models.DateTimeField(auto_now_add=True, db_column="recorded_at")

    class Meta:
        db_table = "live_location_pings"
        ordering = ["-recorded_at"]
        indexes = [models.Index(fields=["employee", "-recorded_at"])]


# ──────────────────────────────────────────────
#  Biometric / Punching Device Configuration
# ──────────────────────────────────────────────

class BiometricDevice(models.Model):
    DEVICE_TYPE_CHOICES = [
        ("aiface_mars", "AiFace-Mars"),
        ("zkteco", "ZKTeco"),
        ("essl", "eSSL"),
        ("generic_http", "Generic HTTP API"),
        ("other", "Other"),
    ]

    name = models.TextField()
    device_type = models.TextField(choices=DEVICE_TYPE_CHOICES, default="aiface_mars", db_column="device_type")
    host = models.TextField(blank=True, default="", help_text="IP address or hostname")
    port = models.IntegerField(null=True, blank=True)
    api_key = models.TextField(blank=True, default="", db_column="api_key")
    # Free-form extra config (auth headers, polling interval, model-specific options)
    connection_config = models.JSONField(default=dict, blank=True, db_column="connection_config")
    is_active = models.BooleanField(default=True, db_column="is_active")
    is_default = models.BooleanField(default=False, db_column="is_default")
    last_synced_at = models.DateTimeField(null=True, blank=True, db_column="last_synced_at")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    # Serial number the device reports when it pushes over ADMS (the `SN`
    # query param, e.g. "CQIK222560204"). Pull-based sync identifies a device
    # by host/IP, but a push arrives with no IP we can trust -only this -so
    # without it there's no way to tell WHICH configured device a push came
    # from, and therefore no way to say which one has gone quiet.
    # Auto-filled on first push when blank; see adms_views.record_push.
    serial_number = models.TextField(blank=True, default="", db_column="serial_number")
    # Last time this device pushed anything over ADMS. Distinct from
    # last_synced_at, which records the opposite direction (us pulling from
    # it) -a device can be perfectly healthy on one and silent on the other.
    last_push_at = models.DateTimeField(null=True, blank=True, db_column="last_push_at")

    # ── What the server has seen of this device, for the Biometric Device Status page ──────────────────────────────
    # Every column below is written by the ADMS listener or by a connection check, and read by device_status.py.
    # Nullable or with a database default, so a deploy that is still running the previous release keeps working.
    #
    # Last time the device polled us (GET /iclock/getrequest, about every 10 s while it is online). This is the
    # real "is it connected right now" signal: a push only happens when somebody punches.
    last_heartbeat_at = models.DateTimeField(null=True, blank=True, db_column="last_heartbeat_at")
    # Last time attendance data (an ATTLOG push) arrived, and the newest punch in it (the device's wall clock).
    last_data_at = models.DateTimeField(null=True, blank=True, db_column="last_data_at")
    last_punch_date = models.DateField(null=True, blank=True, db_column="last_punch_date")
    last_punch_time = models.TimeField(null=True, blank=True, db_column="last_punch_time")
    # The public address the push came from (the factory's internet IP as the server sees it).
    last_remote_ip = models.TextField(blank=True, default="", db_default="", db_column="last_remote_ip")
    # The last thing that went wrong while receiving from it (for example attendance lines that could not be read).
    last_error = models.TextField(blank=True, default="", db_default="", db_column="last_error")
    last_error_at = models.DateTimeField(null=True, blank=True, db_column="last_error_at")
    # What the device said about itself in its own ADMS "options" upload (IP, firmware, time zone...).
    reported_config = models.JSONField(null=True, blank=True, db_column="reported_config")
    reported_config_at = models.DateTimeField(null=True, blank=True, db_column="reported_config_at")
    # The pull direction (us connecting to the device): why the last attempt failed, and when we last got through.
    last_sync_error = models.TextField(blank=True, default="", db_default="", db_column="last_sync_error")
    last_sync_error_at = models.DateTimeField(null=True, blank=True, db_column="last_sync_error_at")
    last_reachable_at = models.DateTimeField(null=True, blank=True, db_column="last_reachable_at")

    # ── What Device Control last read from the device itself ───────────────────────────────────────────────────────
    # When its user table was last read into biometric_device_users, and why the last attempt failed (empty when it
    # did not). Additive and nullable / defaulted, so a release still running the previous code keeps working.
    users_read_at = models.DateTimeField(null=True, blank=True, db_column="users_read_at")
    users_read_error = models.TextField(blank=True, default="", db_default="", db_column="users_read_error")
    # Capacity and identity as the device reported them: {users, usersCap, records, recordsCap, faces, facesCap, cards,
    # pinWidth, platform, firmware, serial}. Null until the first successful read.
    capacity = models.JSONField(null=True, blank=True, db_column="capacity")

    class Meta:
        db_table = "biometric_devices"
        ordering = ["-is_default", "name"]


class BiometricProbe(models.Model):
    """One connection check of one device, run from the server (ping, TCP port, device handshake, settings read).
    Kept as a short history so the status page can show whether a device is slow or flapping, not only its last
    state. The status page prunes each device to its latest PROBE_HISTORY_KEEP rows."""

    device = models.ForeignKey(
        BiometricDevice, on_delete=models.CASCADE, db_column="device_id", related_name="probes"
    )
    checked_at = models.DateTimeField(db_column="checked_at")
    # reachable | timeout | refused | unreachable | dns | auth | error
    status = models.TextField()
    latency_ms = models.FloatField(null=True, blank=True, db_column="latency_ms")
    icmp_ms = models.FloatField(null=True, blank=True, db_column="icmp_ms")
    error = models.TextField(blank=True, default="")
    # What the device reported about itself (serial, IP, gateway, DNS, server address...), when it answered.
    detail = models.JSONField(null=True, blank=True)
    # The steps tried and how each went: [{"key", "label", "ok", "ms", "note"}]
    steps = models.JSONField(null=True, blank=True)
    checked_from = models.TextField(blank=True, default="", db_column="checked_from")

    class Meta:
        db_table = "biometric_device_probes"
        ordering = ["-checked_at"]
        indexes = [models.Index(fields=["device", "-checked_at"])]


class BiometricUnknownPusher(models.Model):
    """A device that contacts the ADMS listener under a serial number no configured device carries. Either it is
    a new machine nobody has added in Settings, or a configured one whose serial was typed wrongly: either way it
    is worth showing, because its attendance is arriving from a device the portal does not know."""

    serial_number = models.TextField(unique=True, db_column="serial_number")
    first_seen_at = models.DateTimeField(db_column="first_seen_at")
    last_seen_at = models.DateTimeField(db_column="last_seen_at")
    last_remote_ip = models.TextField(blank=True, default="", db_column="last_remote_ip")
    contact_count = models.IntegerField(default=0, db_column="contact_count")
    punch_count = models.IntegerField(default=0, db_column="punch_count")

    class Meta:
        db_table = "biometric_unknown_pushers"
        ordering = ["-last_seen_at"]


class BiometricDeviceUser(models.Model):
    """One user as a biometric device holds it, as last read from that device (Device Control → Data Push).

    A snapshot, not the source of truth: the device is. It exists so the page can filter, search and compare every
    device's users at once without opening a connection per click, and says when it was read. Rewritten by every
    read of the device and updated by every add / edit / delete made through the portal.

    user_id is the PIN printed on the device and, by this company's rule, the Employee Code (see
    biometric_sync._active_employee_lookup); uid is the device's own record number. The device password is never
    stored here, only whether there is one."""

    device = models.ForeignKey(
        BiometricDevice, on_delete=models.CASCADE, db_column="device_id", related_name="device_users"
    )
    uid = models.IntegerField(db_column="uid")
    user_id = models.TextField(db_column="user_id", db_index=True)
    name = models.TextField(blank=True, default="")
    privilege = models.IntegerField(default=0)
    card = models.BigIntegerField(default=0)
    has_password = models.BooleanField(default=False, db_column="has_password")
    group = models.TextField(blank=True, default="")
    read_at = models.DateTimeField(db_column="read_at")

    class Meta:
        db_table = "biometric_device_users"
        ordering = ["device_id", "uid"]
        unique_together = [("device", "uid")]
        indexes = [models.Index(fields=["device", "user_id"])]


class BiometricFetchRun(models.Model):
    """One manual fetch of punches from biometric devices (Device Control → Data Fetch), kept as a history.

    A run is either a preview (reads the devices and reports what an update would do, changes nothing) or an update
    (writes the new punches through the same path the Sync Biometric button uses). It runs on a background thread, so
    the row is what the page polls: status, and one entry per device in `results` that fills in as each finishes."""

    MODE_PREVIEW = "preview"
    MODE_UPDATE = "update"

    mode = models.TextField(default=MODE_UPDATE)
    status = models.TextField(default="running")  # running | done | failed
    started_by = models.TextField(blank=True, default="", db_column="started_by")
    range_label = models.TextField(blank=True, default="", db_column="range_label")
    date_from = models.DateField(null=True, blank=True, db_column="date_from")
    date_to = models.DateField(null=True, blank=True, db_column="date_to")
    device_ids = models.JSONField(default=list, db_column="device_ids")
    results = models.JSONField(default=list)
    summary = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")
    finished_at = models.DateTimeField(null=True, blank=True, db_column="finished_at")

    class Meta:
        db_table = "biometric_fetch_runs"
        ordering = ["-created_at"]


class UnmatchedPunch(models.Model):
    """A punch whose device user ID matches no Employee -i.e. someone is
    clocking in but their attendance is being discarded.

    Previously this was only ever written to the server log, so it was
    invisible in the portal and effectively undiscoverable: real people were
    punching every day and simply not being recorded. This table makes it a
    reviewable list instead.

    Aggregated per (device user ID, device) rather than one row per punch —
    HR needs "this ID has been punching for two weeks with no employee
    record", not thousands of individual rows saying the same thing.
    """
    device_user_id = models.TextField(db_index=True, db_column="device_user_id")
    device_label = models.TextField(blank=True, default="", db_column="device_label")
    device_serial = models.TextField(blank=True, default="", db_column="device_serial")
    punch_count = models.IntegerField(default=0, db_column="punch_count")
    first_seen_at = models.DateTimeField(auto_now_add=True, db_column="first_seen_at")
    last_seen_at = models.DateTimeField(auto_now=True, db_column="last_seen_at")
    last_punch_date = models.DateField(null=True, blank=True, db_column="last_punch_date")
    last_punch_time = models.TimeField(null=True, blank=True, db_column="last_punch_time")
    # Set once HR has dealt with it (created the employee, fixed the code, or
    # decided it's a device/test account that should be ignored). Kept rather
    # than deleted so a resolved ID that starts punching again is obvious.
    resolved = models.BooleanField(default=False, db_column="resolved")
    resolved_note = models.TextField(blank=True, default="", db_column="resolved_note")

    class Meta:
        db_table = "unmatched_punches"
        ordering = ["-last_seen_at"]
        unique_together = [("device_user_id", "device_serial")]


class AutoSyncRule(models.Model):
    """A configurable timing rule for background biometric sync -one
    APScheduler CronTrigger job per enabled rule (see auto_sync.py). Replaces
    the old hardcoded 07:30/20:30 schedule in apps.py with HR-editable rules."""

    MODE_CHOICES = [
        ("day", "Today"),
        ("week", "Last One Week"),
        ("month", "Last One Month"),
        ("all", "All Records"),
    ]

    name = models.TextField(blank=True, default="")
    time = models.TimeField(help_text="Time of day (Asia/Kolkata) this rule fires")
    # Cron-compatible day-of-week string, e.g. "*" (every day) or "mon,tue,wed,thu,fri".
    days_of_week = models.TextField(default="*")
    # Empty list = every enabled device (matches the manual Sync Biometric
    # "no selection = all" convention). Entries are device PKs or "env".
    device_selection = models.JSONField(default=list, blank=True)
    mode = models.TextField(choices=MODE_CHOICES, default="day")
    is_enabled = models.BooleanField(default=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_run_status = models.TextField(null=True, blank=True)
    last_run_summary = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "auto_sync_rules"
        ordering = ["time"]
