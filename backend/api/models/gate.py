"""Outpass, gate scanners, visitors, reception and tea break."""

from django.db import models
import uuid

from .attendance import OnDutySession
from .core import Branch, Employee


# ──────────────────────────────────────────────
#  Outpass / Visitors -pure gate data-collection, no attendance/payroll link
# ──────────────────────────────────────────────

class GateQRCode(models.Model):
    """One permanent QR token per (branch, kind) -generated once via
    get_or_create_for(), never rotated automatically, so the physical QR
    print at a gate keeps working indefinitely. Kept separate from the
    per-employee ID-card QR (IdCardViews.tsx/verify_employee) -that one
    identifies a person; this one identifies "the outpass/visitor form for
    branch X", the token itself carrying no PII."""

    KIND_OUTPASS = "outpass"
    KIND_VISITOR = "visitor"
    KIND_CHOICES = [(KIND_OUTPASS, "Outpass"), (KIND_VISITOR, "Visitor")]

    branch = models.ForeignKey(
        Branch, on_delete=models.CASCADE, db_column="branch_id", related_name="gate_qr_codes"
    )
    kind = models.TextField(choices=KIND_CHOICES, db_column="kind")
    token = models.TextField(unique=True, db_column="token")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "gate_qr_codes"
        constraints = [
            models.UniqueConstraint(fields=["branch", "kind"], name="uniq_branch_qr_kind"),
        ]

    @classmethod
    def get_or_create_for(cls, branch: "Branch", kind: str) -> "GateQRCode":
        obj, _ = cls.objects.get_or_create(branch=branch, kind=kind, defaults={"token": uuid.uuid4().hex})
        return obj


class OutpassRecord(models.Model):
    """A single gate exit, submitted anonymously from the QR form -see
    outpass_visitor_views.py::outpass_gate_submit. employee_name/employee_code
    are free text rather than only the FK so a typo'd or unrecognized code
    never blocks the submission; `employee` is populated best-effort."""

    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="outpass_records",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="employee_id", related_name="outpass_records",
    )
    employee_name = models.TextField(db_column="employee_name")
    employee_code = models.TextField(db_column="employee_code")
    destination = models.TextField(db_column="destination")
    submitted_at = models.DateTimeField(auto_now_add=True, db_column="submitted_at")
    # "qr" (gate scan, the original flow) | "request" (approved via
    # OutpassRequest -manual employee request or an approved On-Duty session).
    # Default preserves every row created before this field existed.
    source = models.TextField(default="qr", db_column="source")

    class Meta:
        db_table = "outpass_records"
        ordering = ["-submitted_at"]


class OutpassRequest(models.Model):
    """An employee-initiated (or On-Duty-derived) request for an Outpass,
    approved the same way EmployeePermission is -either the employee's HOD
    or HR is sufficient, whichever acts first. Approval creates a matching
    OutpassRecord (see outpass_visitor_views.py::_create_outpass_record_for)
    so the gate-facing Outpass page needs no changes at all to show it."""

    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"), (STATUS_APPROVED, "Approved"), (STATUS_REJECTED, "Rejected"),
    ]

    SOURCE_MANUAL = "manual"
    SOURCE_ON_DUTY = "on_duty"
    SOURCE_CHOICES = [(SOURCE_MANUAL, "Manual"), (SOURCE_ON_DUTY, "On-Duty")]

    PASS_TYPE_OFFICIAL = "official"
    PASS_TYPE_PERSONAL = "personal"
    PASS_TYPE_EARLY_DISMISSAL = "early_dismissal"
    PASS_TYPE_CHOICES = [
        (PASS_TYPE_OFFICIAL, "Official / Mill Duty"),
        (PASS_TYPE_PERSONAL, "Personal Emergency"),
        (PASS_TYPE_EARLY_DISMISSAL, "Early Shift Dismissal"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="outpass_requests"
    )
    destination = models.TextField(db_column="destination")
    reason = models.TextField(db_column="reason")
    status = models.TextField(choices=STATUS_CHOICES, default=STATUS_PENDING, db_column="status")
    source = models.TextField(choices=SOURCE_CHOICES, default=SOURCE_MANUAL, db_column="source")
    # What kind of pass this is, and when the employee expects to be back —
    # both purely descriptive/informational. Neither changes the real
    # approval-gated pass validity window above (approved_at + 60 minutes),
    # which stays the single source of truth for how long the QR is live.
    pass_type = models.TextField(choices=PASS_TYPE_CHOICES, null=True, blank=True, db_column="pass_type")
    expected_return_at = models.DateTimeField(null=True, blank=True, db_column="expected_return_at")
    on_duty_session = models.ForeignKey(
        OnDutySession, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="on_duty_session_id", related_name="outpass_requests",
    )
    # "hr" | "dept_head" | "system" (auto-approved via an On-Duty approval) —
    # mirrors EmployeePermission.approver_role.
    approver_role = models.TextField(null=True, blank=True, db_column="approver_role")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    review_comment = models.TextField(null=True, blank=True, db_column="review_comment")
    # Who has approved this request so far under the approval pipeline (approval_workflow.py): a list of
    # {"role": "hod"|"hr", "decision", "by", "at", "comment", "skipped"}. Null on requests made before it existed;
    # approval_workflow.trail_of() derives it from the older per-role stamps then.
    approval_trail = models.JSONField(null=True, blank=True, db_column="approval_trail")
    # Pass validity window is approved_at + 60 minutes -computed at read time,
    # not stored, so there's nothing to keep in sync if that window ever changes.
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    outpass_record = models.ForeignKey(
        OutpassRecord, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="outpass_record_id", related_name="+",
    )
    # Set once a gate scan verifies and records the employee's exit -see
    # gate_scanner_views.py::gate_scan. Both null until then; exit_gate uses
    # SET_NULL rather than CASCADE so deleting a gate profile never deletes
    # the historical fact that a pass was exited through it.
    exit_gate = models.ForeignKey(
        "GateDevice", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="exit_gate_id", related_name="exited_requests",
    )
    exited_at = models.DateTimeField(null=True, blank=True, db_column="exited_at")
    # The return leg -mirrors exit_gate/exited_at exactly. return_qr_generated_at
    # is the "manual Generate Return QR button" state: unlike the exit QR (always
    # computable once approved), the return QR is only ever presentable after the
    # employee explicitly asks for it, so there's a real moment to stamp -see
    # outpass_request_views.py::generate_return_qr. Re-clicking the button after
    # the first QR expires simply bumps this timestamp, which invalidates the old
    # token (resolve_gate_scan checks the token's own generatedAt claim against
    # this live column, not just its own signature/exp).
    entry_gate = models.ForeignKey(
        "GateDevice", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="entry_gate_id", related_name="entered_requests",
    )
    entered_at = models.DateTimeField(null=True, blank=True, db_column="entered_at")
    return_qr_generated_at = models.DateTimeField(null=True, blank=True, db_column="return_qr_generated_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "outpass_requests"
        ordering = ["-created_at"]


class GateDevice(models.Model):
    """A login profile for one physical gate-scanner kiosk (e.g. "Gate 1").

    Deliberately separate from GateQRCode (outpass_visitor_views.py) -that
    model is a permanent, tokenized, *unauthenticated* QR for the public
    outpass/visitor entry form; this one is a real username/password login
    for a device that VERIFIES an already-approved OutpassRequest's QR and
    records the employee's exit against a specific gate. Two unrelated
    concepts that happen to share the word "gate".

    Auth is always username+password (see gate_scanner_views.py::gate_login)
    -login_token only identifies which gate a login *link* points at, so the
    kiosk page can show "Logging into Gate 1" before any credentials are
    entered. `is_active` is the revocation switch: require_gate_device
    re-checks it on every request, so deactivating a gate here blocks its
    session immediately without waiting for the JWT to expire.
    """

    name = models.TextField(db_column="name")
    branch = models.ForeignKey(
        Branch, on_delete=models.CASCADE, db_column="branch_id", related_name="gate_devices"
    )
    username = models.TextField(unique=True, db_column="username")
    password_hash = models.TextField(db_column="password_hash")
    login_token = models.TextField(unique=True, db_column="login_token")
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_by = models.TextField(null=True, blank=True, db_column="created_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    last_login_at = models.DateTimeField(null=True, blank=True, db_column="last_login_at")
    # Fernet ciphertext of the current password, written beside password_hash by gate_credentials.set_gate_password so
    # HR can be shown it (Manage Gates -> View). Null = set before 18 Nov 2026 and cannot be shown until a new one is set.
    # Never part of a list / detail / export payload: only POST gate-devices/<id>/reveal-password decrypts it.
    password_encrypted = models.TextField(null=True, blank=True, db_column="password_encrypted")
    location = models.TextField(null=True, blank=True, db_column="location")
    notes = models.TextField(null=True, blank=True, db_column="notes")
    # What this gate may scan: gate passes (exit and return) and / or tea-break QRs. db_default so a backend still
    # running the previous release keeps inserting gates that take both.
    allow_outpass = models.BooleanField(default=True, db_default=True, db_column="allow_outpass")
    allow_tea_break = models.BooleanField(default=True, db_default=True, db_column="allow_tea_break")
    updated_at = models.DateTimeField(null=True, blank=True, db_column="updated_at")
    updated_by = models.TextField(null=True, blank=True, db_column="updated_by")

    class Meta:
        db_table = "gate_devices"
        ordering = ["name"]


class GateSession(models.Model):
    """One signed-in gate monitor (a browser at a gate). The gate's JWT carries `gsid` = sid of one row here, so a
    session can be ended on its own (logout) or with all the gate's others (password reset, username change,
    deactivation, HR "Sign out everywhere") -see gate_credentials.py and auth.require_gate_device. The claim is NOT
    called `jti`: auth._authenticate treats any jti as an HR LoginSession."""

    REVOKED_LOGOUT = "logout"
    REVOKED_PASSWORD_CHANGED = "password_changed"
    REVOKED_HR_SIGNED_OUT = "hr_signed_out"
    REVOKED_DEACTIVATED = "deactivated"
    REVOKED_USERNAME_CHANGED = "username_changed"

    gate = models.ForeignKey(GateDevice, on_delete=models.CASCADE, db_column="gate_id", related_name="sessions")
    sid = models.TextField(unique=True, db_column="sid")
    device_label = models.TextField(blank=True, default="", db_column="device_label")
    user_agent = models.TextField(blank=True, default="", db_column="user_agent")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    last_seen_at = models.DateTimeField(null=True, blank=True, db_column="last_seen_at")
    revoked_at = models.DateTimeField(null=True, blank=True, db_column="revoked_at")
    revoked_reason = models.TextField(null=True, blank=True, db_column="revoked_reason")

    class Meta:
        db_table = "gate_sessions"
        indexes = [models.Index(fields=["gate", "revoked_at"], name="gate_sessions_gate_rev_idx")]


class GateLoginAttempt(models.Model):
    """One row per gate monitor sign-in attempt, for the 5-wrong-tries-in-15-minutes lockout
    (gate_credentials.login_locked_out). `username` is stored trimmed and lower-cased so the lockout query is an exact
    match on the index."""

    username = models.TextField(db_column="username")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    success = models.BooleanField(default=False, db_column="success")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "gate_login_attempts"
        indexes = [models.Index(fields=["username", "created_at"], name="gate_login_att_user_idx")]


class TeaBreakLog(models.Model):
    """One row per tea-break OUT/IN cycle. Deliberately NOT like OutpassRequest:
    there is no approval step and no separate "request" object -an employee's
    own permanent Tea Break QR (see tea_break_views.py::tea_break_qr_token)
    simply toggles this when scanned at any active GateDevice (the same
    gate logins used for Outpass -see resolve_gate_scan's role dispatch in
    gate_scanner_views.py, no separate device/login concept for this).

    A scan with no existing OPEN row (in_at IS NULL) for that employee starts
    a new row (OUT); a scan while one exists closes it (IN) -see
    tea_break_views.py::resolve_tea_break_scan for the toggle + staleness
    logic."""

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="tea_break_logs"
    )
    out_gate = models.ForeignKey(
        "GateDevice", on_delete=models.SET_NULL, null=True, blank=True, db_column="out_gate_id", related_name="+"
    )
    out_at = models.DateTimeField(db_column="out_at")
    in_gate = models.ForeignKey(
        "GateDevice", on_delete=models.SET_NULL, null=True, blank=True, db_column="in_gate_id", related_name="+"
    )
    in_at = models.DateTimeField(null=True, blank=True, db_column="in_at")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "tea_break_logs"
        ordering = ["-out_at"]
        indexes = [models.Index(fields=["out_at"], name="tea_break_logs_out_at_idx")]


class TeaBreakRule(models.Model):
    """Singleton (always pk=1, see get()) -the allowed break duration before
    a COMPLETED break is flagged "Overtime" on the HR dashboard (see
    tea_break_views.py::_log_json). Global, not per-branch, matching the
    simple "one number HR sets" the feature asks for. Separate from the
    fixed, non-configurable 60-minute "not returned" cutoff used for a break
    that's still open (tea_break_views.py::NOT_RETURNED_MINUTES) -that one
    isn't a rule HR tunes, it's just when an open scan stops being plausible."""

    allowed_minutes = models.IntegerField(default=15, db_column="allowed_minutes")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "tea_break_rule"

    @classmethod
    def get(cls) -> "TeaBreakRule":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class OutpassGateScan(models.Model):
    """Audit log of every QR scan attempt at a gate -success AND failure, so
    HR can see not just who exited but who *tried* to and was denied (an
    expired pass re-shown, an already-used pass, a tampered/invalid QR).
    `outpass_request`/`employee` are nullable because an unparseable or
    forged QR never resolves to a real request -the attempt is still worth
    logging."""

    RESULT_SUCCESS = "success"
    RESULT_ALREADY_SCANNED = "already_scanned"
    RESULT_EXPIRED = "expired"
    RESULT_NOT_APPROVED = "not_approved"
    RESULT_INVALID_QR = "invalid_qr"
    RESULT_NOT_EXITED = "not_exited"
    # the gate is switched off for gate passes (GateDevice.allow_outpass): the attempt is refused and still logged
    RESULT_NOT_ALLOWED_HERE = "not_allowed_here"
    RESULT_CHOICES = [
        (RESULT_SUCCESS, "Success"),
        (RESULT_ALREADY_SCANNED, "Already Scanned"),
        (RESULT_EXPIRED, "Expired"),
        (RESULT_NOT_APPROVED, "Not Approved"),
        (RESULT_INVALID_QR, "Invalid QR"),
        (RESULT_NOT_EXITED, "Not Yet Exited"),
        (RESULT_NOT_ALLOWED_HERE, "Not allowed at this gate"),
    ]

    SCAN_TYPE_EXIT = "exit"
    SCAN_TYPE_ENTRY = "entry"
    # a tea-break code refused by a gate that does not take tea breaks (GateDevice.allow_tea_break, since 19 Nov 2026):
    # always a denied row (RESULT_NOT_ALLOWED_HERE). Allowed tea breaks are TeaBreakLog rows, never scans here.
    SCAN_TYPE_TEA = "tea"
    SCAN_TYPE_CHOICES = [(SCAN_TYPE_EXIT, "Exit"), (SCAN_TYPE_ENTRY, "Entry"), (SCAN_TYPE_TEA, "Tea break")]

    gate = models.ForeignKey(
        GateDevice, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="gate_id", related_name="scans",
    )
    outpass_request = models.ForeignKey(
        OutpassRequest, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="outpass_request_id", related_name="gate_scans",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="employee_id", related_name="+",
    )
    # Which leg this attempt was for -exit-QR vs return-QR -so a single
    # OutpassRequest's audit trail (up to two successes plus any denied
    # attempts of either kind) can be told apart. Defaults to "exit" since
    # every scan before this field existed was necessarily an exit attempt.
    scan_type = models.TextField(choices=SCAN_TYPE_CHOICES, default=SCAN_TYPE_EXIT, db_column="scan_type")
    result = models.TextField(choices=RESULT_CHOICES, db_column="result")
    message = models.TextField(db_column="message")
    scanned_at = models.DateTimeField(auto_now_add=True, db_column="scanned_at")

    class Meta:
        db_table = "outpass_gate_scans"
        ordering = ["-scanned_at"]
        indexes = [models.Index(fields=["gate", "scanned_at"], name="outpass_gate_scans_gate_idx")]


class Visitor(models.Model):
    """A real person's identity, deduped by phone -visit-specific details
    (why/whom/purpose) live on VisitorVisit below, so a returning visitor
    scanning the gate QR again reuses this row (see
    outpass_visitor_views.py::visitor_gate_repeat) instead of a second
    person record with the same name/Aadhaar re-entered."""

    name = models.TextField(db_column="name")
    phone = models.TextField(unique=True, db_column="phone")
    aadhaar_number = models.TextField(null=True, blank=True, db_column="aadhaar_number")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "visitors"


class VisitorVisit(models.Model):
    """One row per physical visit. KPI counts ("Today's/Week's/Month's
    visitor records") are counts of this table, not of Visitor -a repeat
    visitor still adds one more real visit to count."""

    visitor = models.ForeignKey(Visitor, on_delete=models.CASCADE, db_column="visitor_id", related_name="visits")
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="branch_id", related_name="visitor_visits",
    )
    why_came = models.TextField(null=True, blank=True, db_column="why_came")
    whom_to_meet = models.TextField(db_column="whom_to_meet")
    purpose = models.TextField(db_column="purpose")
    # Free-text whom_to_meet above is kept exactly as before (always set,
    # even when this FK can't be resolved) -this is the ADDITIVE, strong
    # link, populated when the visitor gate form looks up the person they're
    # meeting by phone number against the Employee table (see
    # outpass_visitor_views.py::visitor_check_employee_phone) and gets a
    # match. Never required: a visitor who doesn't know an exact phone match,
    # or isn't here for anyone specific, still checks in exactly as before.
    meeting_employee = models.ForeignKey(
        Employee, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="meeting_employee_id", related_name="visitor_visits_as_host",
    )
    # Set once the "you have a visitor" notification actually goes out on
    # that channel -see outpass_visitor_views.py::_notify_employee_of_visitor.
    # Both null when there's no meeting_employee to notify, or when sending
    # was attempted and failed (not configured, no email/phone on file, etc.)
    # -failure is never surfaced back to the visitor, only to the Reception
    # dashboard, since check-in must always succeed regardless of whether the
    # host could be reached.
    notified_email_at = models.DateTimeField(null=True, blank=True, db_column="notified_email_at")
    notified_whatsapp_at = models.DateTimeField(null=True, blank=True, db_column="notified_whatsapp_at")
    visited_at = models.DateTimeField(auto_now_add=True, db_column="visited_at")

    # How the visit was checked in, and its check-out (both from 18 Nov 2026; every older row is a QR self check-in
    # with no check-out). db_default so a backend still running the previous release keeps inserting QR visits.
    SOURCE_QR = "qr"  # the visitor's own phone, through the branch's visitor QR
    SOURCE_HR = "hr"  # registered by HR on the Visitors page
    SOURCE_RECEPTION = "reception"  # registered at a reception desk
    SOURCE_CHOICES = [(SOURCE_QR, "QR self check-in"), (SOURCE_HR, "HR"), (SOURCE_RECEPTION, "Reception")]
    source = models.TextField(choices=SOURCE_CHOICES, default=SOURCE_QR, db_default=SOURCE_QR, db_column="source")
    # display name of the HR user / desk that registered it; null for a QR self check-in
    checked_in_by = models.TextField(null=True, blank=True, db_column="checked_in_by")
    checked_out_at = models.DateTimeField(null=True, blank=True, db_column="checked_out_at")
    checked_out_by = models.TextField(null=True, blank=True, db_column="checked_out_by")
    checkout_source = models.TextField(null=True, blank=True, db_column="checkout_source")  # "hr" | "reception"
    company = models.TextField(null=True, blank=True, db_column="company")
    vehicle_number = models.TextField(null=True, blank=True, db_column="vehicle_number")
    people_count = models.PositiveSmallIntegerField(default=1, db_default=1, db_column="people_count")
    id_proof_type = models.TextField(null=True, blank=True, db_column="id_proof_type")
    badge_number = models.TextField(null=True, blank=True, db_column="badge_number")
    notes = models.TextField(null=True, blank=True, db_column="notes")
    # The reception desk that checked the visitor in (a walk-in registered at the desk) / out, from 18 Nov 2026, so Manage
    # Reception can count and list each desk login's records. SET_NULL: deleting a desk never deletes a visit (its
    # checked_in_by / checked_out_by text keeps the desk's name).
    checked_in_desk = models.ForeignKey(
        "ReceptionDevice", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="checked_in_desk_id", related_name="checked_in_visits",
    )
    checked_out_desk = models.ForeignKey(
        "ReceptionDevice", on_delete=models.SET_NULL, null=True, blank=True,
        db_column="checked_out_desk_id", related_name="checked_out_visits",
    )

    class Meta:
        db_table = "visitor_visits"
        ordering = ["-visited_at"]
        indexes = [models.Index(fields=["visited_at"], name="visitor_visits_visited_idx")]


class ReceptionDevice(models.Model):
    """A login profile for the Reception desk (per branch) -structurally
    identical to GateDevice (gate_scanner_views.py's own docstring explains
    the shape/reasoning; this mirrors it exactly), just for a different
    kiosk: instead of scanning an Outpass QR to record an exit, this login
    gives Reception staff their own dashboard onto VisitorVisit -today's
    visitor count, who they came to see, and their details -without needing
    an HR login at all. It never handles scanning itself: the visitor's own
    phone scanning the existing permanent per-branch Visitor QR (GateQRCode)
    remains the only way a visit gets recorded; this is a read (+ device
    management) surface on top of that same data.

    Auth is always username+password (see reception_views.py::reception_login)
    -login_token only identifies which desk a login *link* points at.
    `is_active` is the revocation switch, re-checked on every request by
    require_reception_device exactly like require_gate_device does for
    GateDevice.

    Since 18 Nov 2026 a desk signs in at the one shared /reception-login page
    into a revocable ReceptionSession (30-day token, lockout after 5 wrong
    tries: reception_credentials.py), registers walk-in visitors and checks
    them out (VisitorVisit.checked_in_desk / checked_out_desk), and HR manages
    every desk on Visitors -> Manage Reception (reception_admin_views.py).
    """

    name = models.TextField(db_column="name")
    branch = models.ForeignKey(
        Branch, on_delete=models.CASCADE, db_column="branch_id", related_name="reception_devices"
    )
    username = models.TextField(unique=True, db_column="username")
    password_hash = models.TextField(db_column="password_hash")
    login_token = models.TextField(unique=True, db_column="login_token")
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_by = models.TextField(null=True, blank=True, db_column="created_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    last_login_at = models.DateTimeField(null=True, blank=True, db_column="last_login_at")
    # Manage Reception (18 Nov 2026), the same as GateDevice: the Fernet copy of the password for HR's View (never in a
    # list / detail / export payload: only POST reception-devices/<id>/reveal-password decrypts it; null = set before
    # this feature), where the desk is, notes, and who changed it last (updated_at also ends a sign-in lock).
    password_encrypted = models.TextField(null=True, blank=True, db_column="password_encrypted")
    location = models.TextField(null=True, blank=True, db_column="location")
    notes = models.TextField(null=True, blank=True, db_column="notes")
    updated_at = models.DateTimeField(null=True, blank=True, db_column="updated_at")
    updated_by = models.TextField(null=True, blank=True, db_column="updated_by")

    class Meta:
        db_table = "reception_devices"
        ordering = ["name"]


class ReceptionSession(models.Model):
    """One signed-in reception desk browser (/reception-login), exactly like GateSession for gates. The desk's JWT carries
    `rsid` = sid of one row here, so one browser can be signed out (logout) or all of the desk's (password reset, username
    change, switching it off, HR "Sign out everywhere") -see reception_credentials.py and auth.require_reception_device.
    The claim is NOT `jti` (auth._authenticate reads any jti as an HR LoginSession) and not `gsid` (a gate's)."""

    REVOKED_LOGOUT = "logout"
    REVOKED_PASSWORD_CHANGED = "password_changed"
    REVOKED_HR_SIGNED_OUT = "hr_signed_out"
    REVOKED_DEACTIVATED = "deactivated"
    REVOKED_USERNAME_CHANGED = "username_changed"

    desk = models.ForeignKey(ReceptionDevice, on_delete=models.CASCADE, db_column="desk_id", related_name="sessions")
    sid = models.TextField(unique=True, db_column="sid")
    device_label = models.TextField(blank=True, default="", db_column="device_label")
    user_agent = models.TextField(blank=True, default="", db_column="user_agent")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    last_seen_at = models.DateTimeField(null=True, blank=True, db_column="last_seen_at")
    revoked_at = models.DateTimeField(null=True, blank=True, db_column="revoked_at")
    revoked_reason = models.TextField(null=True, blank=True, db_column="revoked_reason")

    class Meta:
        db_table = "reception_sessions"
        indexes = [models.Index(fields=["desk", "revoked_at"], name="reception_sessions_desk_idx")]


class ReceptionLoginAttempt(models.Model):
    """One row per reception desk sign-in attempt, for the 5-wrong-tries-in-15-minutes lockout
    (reception_credentials.login_locked_out). Kept apart from GateLoginAttempt on purpose: a username is unique per table,
    so a desk and a gate may share one. `username` is stored trimmed and lower-cased."""

    username = models.TextField(db_column="username")
    ip_address = models.TextField(null=True, blank=True, db_column="ip_address")
    success = models.BooleanField(default=False, db_column="success")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "reception_login_attempts"
        indexes = [models.Index(fields=["username", "created_at"], name="reception_login_att_user_idx")]
