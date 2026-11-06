"""
The catalog of every WhatsApp message the HRMS can send.

    HRMS module -> notification service -> TEMPLATE (this file) -> queue -> provider -> employee

One entry per message type says what it is called, which HRMS module it belongs
to, which switch on the WhatsApp Control page turns it off, its default wording
and which {{variables}} that wording may use. Everything else -the control page,
the template editor, the message log, the on/off checks, the send queue- reads this
catalog, so adding a new notification is one entry here plus one call to
`whatsapp_service.send_notification` from the module that raises it.

Each type also says how the send queue treats it (whatsapp_dispatcher.py):

  kind        code       a one-time code the employee is waiting for: sent at once, never queued
              requested  about the employee's own request (approved / rejected, Geo decisions)
              automatic  the system decided it (attendance alerts, reminders, gate, visitors, HoD
                         reminders): at most WhatsAppSettings.max_per_employee_per_day of these per
                         employee per day
              document   a file HR sends
  priority    lower goes first: code 0, document 3, requested 4, automatic 5
  freshness   minutes after it was raised that it is still worth sending (None: until the end of the
              day). Nothing is ever sent after the end of the day it was raised on (IST).

Wording uses {{name}} placeholders. Older types also accept the numbered form
({{1}}, {{2}} ...) that HR's already-saved wording was written with: the number is
the variable's position in `variables`, so the ORDER of a legacy type's
variables must never change (append new ones at the end).

A line whose placeholders are all empty is dropped when a message is rendered,
so optional details ("Note: {{comment}}") simply vanish when there is nothing to
say instead of leaving an empty label behind.

The default wordings were reviewed on 2026-11-06 to look like a company writing to its own
staff, not a bulk sender: short, plain, no emojis or capitals, no motivational lines, signed
"- UK Textiles HR", no link in an automatic message (only the Geo punch decisions carry a map
link). Wording HR saved on the Message Text tab is never touched.

No message carries a link to the Employee Web App (the owner does not want one), and the
placeholder that used to hold it is gone: see RETIRED_VARIABLES for how wording HR saved
earlier is kept from ever printing it.

This module deliberately imports nothing from the rest of the app (models import it).
"""

from dataclasses import dataclass

# ── modules (what the "Related HRMS module" column and the filters show) ────────

MODULES = {
    "documents": "Documents",
    "otp": "OTP & Login",
    "attendance": "Attendance",
    "approvals": "Approvals",
    "geo": "Geo Attendance",
    "visitors": "Visitors",
    "outpass": "Outpass & Gate",
    "other": "Other",
}

# The switch (a WhatsAppSettings column) that turns a whole module off. A module
# with no entry is controlled only by its per-message switches.
MODULE_SWITCHES = {
    "documents": "document_notifications_enabled",
    "attendance": "attendance_alerts_enabled",
    "approvals": "approval_notifications_enabled",
    "visitors": "visitor_notification_enabled",
    "outpass": "outpass_notifications_enabled",
}

# The individual approval workflows that share the two Approved / Rejected
# templates. HR can switch each one off; the keys are stored in
# WhatsAppSettings.disabled_approval_modules. (Geo Attendance and Punch Approval
# have their own wording under the "geo" module.)
APPROVAL_MODULES = {
    "leave": "Leave",
    "permission": "Permission",
    "casual_leave": "Casual Leave",
    "missing_punch": "Missing Punch",
    "outpass": "Gate Outpass",
    "attendance_correction": "Attendance Correction",
    "holiday_work": "Holiday Work Compensation",
    "resignation": "Resignation",
    "advance": "Advance",
    "request": "Other Requests",
}

# ── how the send queue treats each kind (see the module docstring) ──────────────

KIND_CODE = "code"
KIND_REQUESTED = "requested"
KIND_AUTOMATIC = "automatic"
KIND_DOCUMENT = "document"
KINDS = (KIND_CODE, KIND_REQUESTED, KIND_AUTOMATIC, KIND_DOCUMENT)

# The kind a module's messages have unless the entry says otherwise.
_KIND_OF_MODULE = {
    "documents": KIND_DOCUMENT,
    "otp": KIND_CODE,
    "attendance": KIND_AUTOMATIC,
    "approvals": KIND_REQUESTED,
    "geo": KIND_REQUESTED,
    "visitors": KIND_AUTOMATIC,
    "outpass": KIND_AUTOMATIC,
}
PRIORITY_OF_KIND = {KIND_CODE: 0, KIND_DOCUMENT: 3, KIND_REQUESTED: 4, KIND_AUTOMATIC: 5}
# A bulk send (every salary slip of a month) goes behind everything time-critical, so a few hundred documents never
# starve an approval or an alert until it is too late to send.
PRIORITY_BULK = 6


@dataclass(frozen=True)
class Variable:
    name: str
    help: str
    sample: str


@dataclass(frozen=True)
class MessageType:
    key: str
    label: str
    module: str
    body: str
    variables: tuple = ()
    # WhatsAppSettings column that switches just this message on/off, if any. A type without one (or sharing one with
    # another type) is switched one by one through WhatsAppSettings.disabled_message_types.
    switch: str | None = None
    # A one-time code that is missing from the wording would be a message nobody can log in with.
    must_contain_code: bool = False
    # Messages with no editable wording (a contact card carries no text).
    has_wording: bool = True
    description: str = ""
    # The send queue (module docstring). Filled in by _add from the module when not given.
    kind: str = ""
    priority: int = 5
    # Minutes after it was raised that it is still worth sending; None = until the end of that day.
    fresh_minutes: int | None = None
    # A WhatsAppSettings column holding the freshness in minutes instead (a punch reminder: its lead window).
    fresh_setting: str | None = None

    @property
    def variable_names(self) -> list[str]:
        return [v.name for v in self.variables]


def V(name: str, help: str, sample: str) -> Variable:
    return Variable(name, help, sample)


_TYPES: list[MessageType] = []


def _add(**kwargs) -> None:
    kind = kwargs.get("kind") or _KIND_OF_MODULE.get(kwargs["module"], KIND_AUTOMATIC)
    kwargs["kind"] = kind
    kwargs.setdefault("priority", PRIORITY_OF_KIND[kind])
    _TYPES.append(MessageType(**kwargs))


# The sign-off of every default wording: who the message is from.
SIGN = "- UK Textiles HR"

# Placeholders no message type offers any more. Wording HR saved before they were retired (migration 0130 removes
# them from the stored text; this is the second line of defence) can still name one: the editor refuses it as an
# unknown placeholder, and rendering drops the whole line instead of sending an empty label or a stray address.
# "link" was the Employee Web App address of the request in the two approval messages.
RETIRED_VARIABLES = frozenset({"link"})

# ── Documents (the wording is a caption; the file itself is attached) ─────────

_add(
    key="salary_slip",
    label="Salary Slip",
    module="documents",
    description="The salary slip PDF, sent with a short caption.",
    body=f"*Salary Slip*\n\nDear {{{{employee_name}}}},\nYour salary slip for {{{{month_year}}}} is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"), V("month_year", "Month and year", "August 2026")),
)
_add(
    key="id_card",
    label="ID Card",
    module="documents",
    description="The employee ID card image, sent with a short caption.",
    body=f"*Employee ID Card*\n\nDear {{{{employee_name}}}},\nYour employee ID card is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="offer_letter",
    label="Offer Letter",
    module="documents",
    description="The offer letter PDF, sent with a short caption.",
    body=(
        f"*Offer Letter*\n\nDear {{{{employee_name}}}},\nYour offer letter for the position of {{{{designation}}}} "
        f"is attached.\n\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("designation", "Designation offered", "Line Supervisor"),
    ),
)
_add(
    key="experience_letter",
    label="Experience Letter",
    module="documents",
    description="The experience letter PDF, sent with a short caption.",
    body=f"*Experience Letter*\n\nDear {{{{employee_name}}}},\nYour experience letter is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="resignation_letter",
    label="Resignation Letter",
    module="documents",
    description="The resignation letter PDF, sent with a short caption.",
    body=(
        f"*Resignation Letter*\n\nDear {{{{employee_name}}}},\nYour resignation letter is attached.\n"
        f"Last working day: {{{{last_working_day}}}}\n\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("last_working_day", "Last working day", "30 Sep 2026"),
    ),
)
_add(
    key="other",
    label="Other Document",
    module="documents",
    description="Any other employee document HR sends from the Documents page.",
    body=f"*Document*\n\nDear {{{{employee_name}}}},\nYour {{{{document_category}}}} document is attached.\n\n{SIGN}",
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("document_category", "Document category", "Appointment Letter"),
    ),
)

# ── OTP & login (the code is never stored in the history; sent at once, never queued) ───

_CODE_VARS = (
    V("code", "The 6-digit code (keep it in the text)", "123456"),
    V("minutes", "Minutes until the code expires", "5"),
)
_add(
    key="otp_login",
    label="Login OTP",
    module="otp",
    description="The code an employee enters to sign in to the apps.",
    switch="otp_login_enabled",
    must_contain_code=True,
    body="{{1}} is your UK Textiles HRMS login code. It expires in {{2}} minutes.\n\nNever share this code with anyone.",
    variables=_CODE_VARS,
)
_add(
    key="otp_reset",
    label="Password Reset OTP",
    module="otp",
    description="The code that confirms a forgotten-password reset.",
    switch="otp_reset_enabled",
    must_contain_code=True,
    body=(
        "{{1}} is your UK Textiles HRMS password reset code. It expires in {{2}} minutes.\n\n"
        "If you didn't ask to reset your password, ignore this message and tell HR."
    ),
    variables=_CODE_VARS,
)
_add(
    key="otp_activate",
    label="Account Activation OTP",
    module="otp",
    description="The code that confirms a new employee before they choose a first password.",
    switch="otp_activate_enabled",
    must_contain_code=True,
    body=(
        "{{1}} is your UK Textiles HRMS account activation code. It expires in {{2}} minutes.\n\n"
        "Enter it in the app to set your password. Never share this code with anyone."
    ),
    variables=_CODE_VARS,
)

# ── Attendance alerts and punch reminders (automatic, checked every minute) ────

_add(
    key="absent_alert",
    label="Absent Alert",
    module="attendance",
    description="Sent when no punch has been recorded within the permitted time after the employee's shift starts.",
    switch="absent_alert_enabled",
    fresh_minutes=60,
    body=(
        "*Attendance Check*\n\n"
        "Dear {{employee_name}},\n"
        "We have not received your attendance punch today.\n\n"
        "Date: {{date}}\n"
        "Shift start: {{shift_start}}\n"
        "Punch allowed until: {{cutoff_time}}\n\n"
        "If you are at work, please punch in. If you are absent today, please inform HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "8:30 AM"),
        V("cutoff_time", "Last time a punch was still accepted", "9:30 AM"),
        V("status", "Attendance status", "No punch recorded yet"),
        V("shift_end", "Shift end time", "5:30 PM"),
        V("wait_minutes", "Minutes allowed after the shift starts", "60"),
    ),
)
_add(
    key="late_alert",
    label="Late Attendance Alert",
    module="attendance",
    description="Sent as soon as the first punch of the day is seen to be after the shift start plus the shift's own grace period.",
    switch="late_alert_enabled",
    fresh_minutes=30,
    body=(
        "*Late Attendance*\n\n"
        "Dear {{employee_name}},\n"
        "Your attendance today has been marked as {{status}}.\n\n"
        "Date: {{date}}\n"
        "Shift start: {{shift_start}}\n"
        "Grace period: {{grace_period}}\n"
        "First punch: {{first_punch}}\n"
        "Late by: {{late_by}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "9:00 AM"),
        V("first_punch", "Time of the first punch", "9:25 AM"),
        V("late_by", "How late, counted from the end of the grace period", "15 minutes"),
        V("status", "Attendance status", "Late"),
        V("grace_minutes", "The shift's grace period in minutes (number only)", "10"),
        V("grace_period", "The shift's grace period, worded", "10 minutes"),
    ),
)
_add(
    key="four_punch_alert",
    label="Punch Reminder",
    module="attendance",
    description=(
        "A short heads-up a few minutes before each of the day's punches (check-in, lunch-out, lunch-in, check-out) "
        "is expected, if it is still missing. Off by default (owner decision, 2026-11-06)."
    ),
    switch="four_punch_alert_enabled",
    fresh_setting="four_punch_lead_minutes",
    body=(
        "*Punch Reminder*\n\n"
        "Dear {{employee_name}},\n"
        "Your {{punch_name}} ({{punch_number}}) is due at {{expected_time}}, in {{minutes_left}}. "
        "Please remember to punch.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is coming up", "Lunch-out"),
        V("hint", "When it is expected", "Expected at 1:00 PM."),
        V("punch_number", "Which of the day's punches", "2 of 4"),
        V("greeting", "Good morning / afternoon / evening", "Good afternoon"),
        V(
            "action",
            "What to do and how soon, worded for this punch",
            "your lunch break is coming up in 15 minutes. Please remember to punch out when you leave for lunch.",
        ),
        V("expected_time", "When the punch is expected", "1:00 PM"),
        V("minutes_left", "How long until then", "15 minutes"),
        V(
            "quote",
            "A short motivational line",
            "Great teams are built by people who show up, stay committed, and give their best every day.",
        ),
        V("closing", "A friendly sign-off for this punch", "Enjoy your break, you've earned it!"),
    ),
)
_add(
    key="on_duty_punch_reminder",
    label="On-Duty Punch Reminder",
    module="attendance",
    description="The same heads-up for employees working On-Duty, asking them to complete their Geo Punch.",
    switch="four_punch_alert_enabled",
    fresh_setting="four_punch_lead_minutes",
    body=(
        "*On-Duty Punch Reminder*\n\n"
        "Dear {{employee_name}},\n"
        "You are on duty at {{destination}} today. Your Geo Punch for {{punch_name}} ({{punch_number}}) is due at "
        "{{expected_time}}, in {{minutes_left}}. Please complete it in the app.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is coming up", "Lunch-in"),
        V("hint", "When it is expected", "Expected at 2:00 PM."),
        V("punch_number", "Which of the day's punches", "3 of 4"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
        V("greeting", "Good morning / afternoon / evening", "Good afternoon"),
        V("expected_time", "When the punch is expected", "2:00 PM"),
        V("minutes_left", "How long until then", "15 minutes"),
        V("quote", "A short motivational line", "Every stitch counts, and so does every person on this team."),
    ),
)
_add(
    key="missing_punch_alert",
    label="Missing Punch Alert",
    module="attendance",
    description="Sent when a punch is still missing a set time after it was expected (20 minutes by default). One message per missing punch.",
    switch="missing_punch_alert_enabled",
    fresh_minutes=60,
    body=(
        "*Missing Punch*\n\n"
        "Dear {{employee_name}},\n"
        "We noticed that {{intro}}\n\n"
        "Punch: {{punch_name}}\n"
        "Expected at: {{expected_time}}\n"
        "Date: {{date}}\n\n"
        "Please punch now. If you have already punched, please contact HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Date", "25 Sep 2026"),
        V("recorded", "Punches recorded so far", "1 of 4"),
        V("missing", "Punches still to come", "Lunch-out, Lunch-in, Evening check-out"),
        V("punch_name", "Which punch is missing", "Morning check-in"),
        V("expected_time", "When it was expected", "9:00 AM"),
        V("status", "Where it stands", "Punch Not Recorded"),
        V("intro", "Which punch is missing, worded for it", "your attendance punch is still missing."),
    ),
)

# ── Approvals: one Approved and one Rejected wording for every workflow ────────

_APPROVAL_VARS = (
    V("employee_name", "Employee name", "Asha Kumar"),
    V("request_type", "Which kind of request (Leave, Permission, ...)", "Leave"),
    V("date", "The date(s) the request is for", "26 Sep 2026 to 27 Sep 2026"),
    V("time", "The time, when the request has one", "10:30 AM"),
    V("details", "What was requested", "Sick Leave - 2 days"),
    V("approver", "Who approved or rejected it", "Meena (HR)"),
    V("comment", "The approver's note or rejection reason, if given", "Get well soon"),
    V("requested_on", "When it was submitted", "24 Sep 2026"),
    V("reason", "The employee's own reason for the request", "Fever"),
)
_add(
    key="approval_approved",
    label="Approval - Approved",
    module="approvals",
    description="Sent to the employee when a Leave, Permission, Casual Leave, Missing Punch, Outpass, Resignation, Advance or other request is approved.",
    body=(
        "*Request Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your *{{request_type}}* request has been approved.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Request: {{details}}\n"
        "Approved by: {{approver}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)
_add(
    key="approval_rejected",
    label="Approval - Rejected",
    module="approvals",
    description="Sent to the employee when one of those requests is rejected, with the reason if one was given.",
    body=(
        "*Request Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your *{{request_type}}* request has been rejected.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Request: {{details}}\n"
        "Rejected by: {{approver}}\n"
        "Reason: {{comment}}\n\n"
        "Please contact HR if you have any questions.\n"
        f"{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)
# The reminder to a Department Head about the requests waiting for their approval (HR Requests page -> Notify,
# hod_reminders.py). Its wording is written on the Notify tab (the same text goes by WhatsApp, email and phone
# notification), so the message here is just that text; wording saved here can wrap it.
_add(
    key="hod_pending_reminder",
    label="HoD Pending Approvals Reminder",
    module="approvals",
    kind=KIND_AUTOMATIC,
    description=(
        "Reminds a Department Head of the requests waiting for their approval, at the times HR set on Requests -> "
        "Notify. The text itself is written on that tab."
    ),
    body="{{message}}",
    variables=(
        V(
            "message",
            "The reminder written on Requests -> Notify, filled in for this Department Head",
            "Dear Suresh Kumar,\nYou currently have some pending requests awaiting your approval in the UK Textiles "
            "HRMS application.\nPending requests:\n• Leave Requests: 3\n• Permission Requests: 1\nKindly review and "
            "approve the pending requests at the earliest.\nRegards,\nHR Team – UKT",
        ),
        V("name", "The Department Head's name", "Suresh Kumar"),
        V("total", "How many requests are waiting for them", "4"),
        V("date", "Today's date", "04 Nov 2026"),
    ),
)

# ── Geo Attendance (On-Duty) and its punches ───────────────────────────────────

_add(
    key="geo_approval",
    label="Geo Attendance Approved",
    module="geo",
    description="Sent when HR gives the final approval of a Geo Attendance (On-Duty) request.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Attendance Request Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance (On-Duty) request has been approved. You can now punch from the app.\n\n"
        "Destination: {{destination}}\n"
        "Requested on: {{requested_on}}\n"
        "Approved by: {{approved_by}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("destination", "The destination they requested", "Tirupur Dyeing Unit"),
        V("requested_on", "When they requested it", "25 Sep 2026, 9:10 AM"),
        V("approved_by", "Who approved it", "Meena"),
        V("note", "The approver's note, already worded as a line (older wording)", "\nNote: Take the van"),
        V("comment", "The approver's note", "Take the van"),
    ),
)
_add(
    key="geo_rejection",
    label="Geo Attendance Rejected",
    module="geo",
    description="Sent when a Geo Attendance (On-Duty) request is rejected, by the Department Head or by HR.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Attendance Request Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance (On-Duty) request has been rejected.\n\n"
        "Destination: {{destination}}\n"
        "Requested on: {{requested_on}}\n"
        "Rejected by: {{rejected_by}}\n"
        "Reason: {{comment}}\n"
        "{{punches_note}}\n\n"
        "Please contact HR if you have any questions.\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("destination", "The destination they requested", "Tirupur Dyeing Unit"),
        V("requested_on", "When they requested it", "25 Sep 2026, 9:10 AM"),
        V("rejected_by", "Who rejected it", "Meena (HR)"),
        V("comment", "The rejection reason, if given", "Not required today"),
        V(
            "punches_note",
            "A line about punches recorded under it, if any",
            "The 2 punch(es) you recorded under it were not counted.",
        ),
    ),
)
_add(
    key="geo_punch_approval",
    label="Geo Punch Approved",
    module="geo",
    description="Sent when HR approves one captured Geo Attendance punch.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Punch Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance {{punch_name}} has been approved.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Location: {{location}}\n"
        "Approved by: {{approved_by}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("punch_name", "Check-In or Check-Out", "Check-In"),
        V("date", "Punch date", "25 Sep 2026"),
        V("time", "Punch time", "9:12 AM"),
        V("location", "A map link to where it was captured", "https://maps.google.com/?q=11.1,77.3"),
        V("approved_by", "Who approved it", "Meena"),
        V("comment", "The approver's note", ""),
    ),
)
_add(
    key="geo_punch_rejection",
    label="Geo Punch Rejected",
    module="geo",
    description="Sent when HR rejects one captured Geo Attendance punch.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Punch Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance {{punch_name}} has been rejected and does not count as attendance. "
        "You can punch again from the app.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Location: {{location}}\n"
        "Rejected by: {{rejected_by}}\n"
        "Reason: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("punch_name", "Check-In or Check-Out", "Check-Out"),
        V("date", "Punch date", "25 Sep 2026"),
        V("time", "Punch time", "5:35 PM"),
        V("location", "A map link to where it was captured", "https://maps.google.com/?q=11.1,77.3"),
        V("rejected_by", "Who rejected it", "Meena"),
        V("comment", "The rejection reason, if given", "Photo was unclear"),
    ),
)

# ── Visitors ───────────────────────────────────────────────────────────────────

_add(
    key="visitor_notification",
    label="Visitor Notification",
    module="visitors",
    description="Tells an employee who has arrived at reception to meet them, and why.",
    fresh_minutes=30,
    body=(
        "*Visitor at Reception*\n\n"
        "Dear {{employee_name}},\n"
        "A visitor is waiting for you at reception.\n\n"
        "Visitor: {{visitor_name}}\n"
        "Contact: {{visitor_phone}}\n"
        "Company: {{company}}\n"
        "Purpose: {{purpose}}\n"
        "Here to meet: {{host_name}}\n"
        "Department: {{department}}\n"
        "Date: {{visit_date}}\n"
        "Time: {{visit_time}}\n"
        "Branch: {{branch}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "The employee being visited", "Asha Kumar"),
        V("visitor_name", "Visitor's name", "Ravi Nair"),
        V("visitor_phone", "Visitor's phone number", "+91 98765 43210"),
        V("purpose", "Purpose of the visit", "Machine service"),
        V("company", "Visitor's company, when given", "Textile Machinery Co."),
        V("host_name", "Whom they came to meet", "Asha Kumar"),
        V("department", "That person's department", "Weaving"),
        V("visit_date", "Date of the visit", "25 Sep 2026"),
        V("visit_time", "Time of arrival", "11:20 AM"),
        V("branch", "The branch they arrived at", "Tirupur"),
        V("why_came", "Why they came, as written on the form", "Vendor"),
    ),
)
_add(
    key="visitor_contact",
    label="Visitor Contact Card",
    module="visitors",
    description="The visitor's contact card, sent right after the visitor message so the employee can tap to call.",
    has_wording=False,
    fresh_minutes=30,
    body="",
)

# ── Outpass & gate movement ────────────────────────────────────────────────────

_GATE_VARS = (
    V("employee_name", "Employee name", "Asha Kumar"),
    V("pass_type", "Outpass type", "Official / Mill Duty"),
    V("destination", "Where they are going", "Bank"),
    V("reason", "Reason for the outpass", "Deposit cheque"),
    V("date", "Date", "25 Sep 2026"),
    V("gate_out_time", "Time recorded going OUT", "2:05 PM"),
    V("gate_in_time", "Time recorded coming back IN", "3:20 PM"),
    V("duration", "How long they were out", "1 hr 15 min"),
    V("gate_name", "The gate that recorded it", "Gate 1"),
    V("status", "Verification status", "Verified"),
    V("approved_by", "Who approved the outpass", "Meena (HR)"),
    V("next_step", "What to do next", "Please scan your Return QR at the gate when you come back."),
)
_add(
    key="outpass_gate_out",
    label="Outpass - Gate OUT",
    module="outpass",
    description="Sent when the gate records an employee going out (a verified outpass scan, or a gate QR form entry).",
    fresh_minutes=30,
    body=(
        "*Gate Exit Recorded*\n\n"
        "Dear {{employee_name}},\n"
        "Your gate exit has been recorded.\n\n"
        "Outpass type: {{pass_type}}\n"
        "Date: {{date}}\n"
        "Gate out: {{gate_out_time}}\n"
        "Destination: {{destination}}\n"
        "Reason: {{reason}}\n"
        "Gate: {{gate_name}}\n"
        "Status: {{status}}\n\n"
        "{{next_step}}\n\n"
        f"{SIGN}"
    ),
    variables=_GATE_VARS,
)
_add(
    key="outpass_gate_in",
    label="Outpass - Gate IN",
    module="outpass",
    description="Sent when the gate records an employee coming back in, with the time they were out.",
    fresh_minutes=30,
    body=(
        "*Gate Return Recorded*\n\n"
        "Dear {{employee_name}},\n"
        "Welcome back. Your return has been recorded.\n\n"
        "Outpass type: {{pass_type}}\n"
        "Date: {{date}}\n"
        "Gate out: {{gate_out_time}}\n"
        "Gate in: {{gate_in_time}}\n"
        "Time out: {{duration}}\n"
        "Destination: {{destination}}\n"
        "Gate: {{gate_name}}\n"
        "Status: {{status}}\n\n"
        f"{SIGN}"
    ),
    variables=_GATE_VARS,
)


# ── lookups ────────────────────────────────────────────────────────────────────

TYPES: dict[str, MessageType] = {t.key: t for t in _TYPES}


def get(key: str) -> MessageType | None:
    return TYPES.get(key)


def label(key: str) -> str:
    t = TYPES.get(key)
    return t.label if t else key


def module_of(key: str) -> str:
    t = TYPES.get(key)
    return t.module if t else "other"


def kind_of(key: str) -> str:
    """The queue kind of a message type (code | requested | automatic | document); an unknown type is automatic."""
    t = TYPES.get(key)
    return t.kind if t else KIND_AUTOMATIC


def types_in(module: str) -> tuple[str, ...]:
    return tuple(t.key for t in _TYPES if t.module == module)


def choices() -> tuple[tuple[str, str], ...]:
    return tuple((t.key, t.label) for t in _TYPES)


def categories() -> dict[str, tuple[str, ...]]:
    return {module: types_in(module) for module in MODULES if types_in(module)}


def individually_switched() -> tuple[str, ...]:
    """The types that need an entry in WhatsAppSettings.disabled_message_types to be switched off one by one: those with
    no boolean switch of their own, and those whose boolean is shared with another type (the two punch reminders, the
    four Geo decisions)."""
    shared: dict[str, int] = {}
    for t in _TYPES:
        if t.switch:
            shared[t.switch] = shared.get(t.switch, 0) + 1
    return tuple(t.key for t in _TYPES if not t.switch or shared[t.switch] > 1)


def variable_help(key: str) -> str:
    t = TYPES.get(key)
    if not t or not t.variables:
        return ""
    return ", ".join(f"{{{{{v.name}}}}} {v.help}" for v in t.variables)


def sample_params(key: str) -> dict[str, str]:
    t = TYPES.get(key)
    return {v.name: v.sample for v in t.variables} if t else {}
